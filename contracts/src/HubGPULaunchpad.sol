// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPonsFactory, IPonsCurve} from "./IPons.sol";

interface IERC20Balance {
    function balanceOf(address owner) external view returns (uint256);
}

/**
 * @title HubGPULaunchpad
 * @notice The door from hubgpu.network to Pons. A creator's GPU measures a quantum circuit once; the outcome (a string
 * of 12 or 16 bits) is the token's birth record. This contract launches the token on Pons with the creator as the
 * creator-fee recipient, writes the birth record into the token's description, makes the creator's required first buy
 * straight into the creator's wallet, and takes HubGPU's flat launch fee.
 *
 * $HGPU utility, enforced here on-chain:
 *  - wallets holding at least `holderMin` $HGPU pay no launch fee;
 *  - only those wallets can launch a 16-bit (rare) birth. A 12-bit birth is open to everyone.
 *
 * Funds: the contract keeps nothing. The Pons launch fee goes to Pons, the first buy goes to the curve (tokens to the
 * creator), the launch fee goes to the treasury, and anything the curve refunds goes back to the creator in the same
 * transaction. The owner can change the fee, but never above MAX_LAUNCH_FEE, and can never touch a creator's funds,
 * tokens or creator fees.
 */
contract HubGPULaunchpad {
    uint8 public constant VERSION = 1;
    /// the owner can never set a launch fee above this
    uint256 public constant MAX_LAUNCH_FEE = 0.01 ether;
    /// the most a launch may spend on its first buy
    uint256 public constant MAX_OPENING_BUY = 1 ether;
    /// the required first buy can be lowered, but never to nothing
    uint256 public constant MIN_OPENING_BUY_FLOOR = 0.00001 ether;
    uint8 public constant BITS = 12;
    uint8 public constant RARE_BITS = 16;

    IPonsFactory public immutable pons;

    address public owner;
    address public pendingOwner;
    address public treasury;
    /// HubGPU's flat fee per launch, in wei
    uint256 public launchFee;
    uint256 public minOpeningBuy;
    /// the $HGPU token and how much a wallet must hold for free launches and rare births (unset until $HGPU exists)
    address public holderToken;
    uint256 public holderMin;
    bool public paused;
    /// wallets that never pay the launch fee (the team, partners)
    mapping(address wallet => bool) public feeExempt;

    struct LaunchArgs {
        string name;
        string symbol;
        string logo;
        string description; // the "Born on HubGPU · |bits⟩" record is appended here by this contract
        string twitter;
        string telegram;
        string website;
        string bits; // the measured outcome: 12 characters of 0/1, or 16 for a rare birth
        bytes32 salt; // Pons CREATE2 salt
        bytes32 expectedEconomics; // pins the Pons terms quoted to the creator; zero accepts the current ones
        uint256 minTokensOut; // floor for the first buy
        uint16 creatorTaxBps; // trade tax paid to the creator, capped by Pons
    }

    address[] public tokens;
    mapping(address token => address creator) public creatorOf;

    uint256 private _lock = 1;

    event TokenBorn(
        address indexed token,
        address indexed creator,
        address curve,
        string bits,
        bool rare,
        uint256 feePaid,
        uint256 firstBuy,
        uint256 tokensOut,
        uint16 creatorTaxBps
    );
    event TreasuryChanged(address treasury);
    event LaunchFeeChanged(uint256 fee);
    event MinOpeningBuyChanged(uint256 amount);
    event HolderTermsChanged(address token, uint256 min);
    event FeeExemptChanged(address indexed wallet, bool exempt);
    event PausedChanged(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error LaunchesPaused();
    error BadBits();
    error RareNeedsHolder();
    error FirstBuyRequired();
    error BadValue();
    error Reentrant();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address pons_, address owner_, address treasury_, uint256 launchFee_) {
        if (pons_ == address(0) || owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (launchFee_ > MAX_LAUNCH_FEE) revert BadValue();
        pons = IPonsFactory(pons_);
        owner = owner_;
        treasury = treasury_;
        launchFee = launchFee_;
        minOpeningBuy = 0.0001 ether;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasuryChanged(treasury_);
        emit LaunchFeeChanged(launchFee_);
        emit MinOpeningBuyChanged(0.0001 ether);
    }

    /// what one launch pays and buys, kept together to keep the stack shallow
    struct Split {
        uint256 ponsFee;
        uint256 fee;
        uint256 buy;
        bool rare;
    }

    /// msg.value = the Pons launch fee + feeFor(creator) + the first buy (at least minOpeningBuy)
    function launch(LaunchArgs calldata a) external payable returns (address token, address curve, uint256 tokensOut) {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        if (paused) revert LaunchesPaused();
        Split memory s = _split(a);

        (token, curve) = _launchOnPons(a, s.ponsFee);
        tokens.push(token);
        creatorOf[token] = msg.sender;

        tokensOut = _settle(curve, s, a.minTokensOut);
        emit TokenBorn(token, msg.sender, curve, a.bits, s.rare, s.fee, s.buy, tokensOut, a.creatorTaxBps);
        _lock = 1;
    }

    /// msg.value → (Pons launch fee, HubGPU fee, first buy); rare births and fee waivers follow the $HGPU balance
    function _split(LaunchArgs calldata a) private view returns (Split memory s) {
        s.rare = _checkBits(a.bits);
        bool holder = isHolder(msg.sender);
        if (s.rare && !holder) revert RareNeedsHolder();
        s.ponsFee = pons.launchFee();
        s.fee = holder || feeExempt[msg.sender] ? 0 : launchFee;
        if (msg.value < s.ponsFee + s.fee + minOpeningBuy) revert FirstBuyRequired();
        s.buy = msg.value - s.ponsFee - s.fee;
        if (s.buy > MAX_OPENING_BUY || a.creatorTaxBps > pons.maxCreatorTaxBps()) revert BadValue();
    }

    /// fee to the treasury, the first buy straight into the creator's wallet, any refund back to the creator
    function _settle(address curve, Split memory s, uint256 minOut) private returns (uint256 tokensOut) {
        if (s.fee != 0) _pay(treasury, s.fee);
        tokensOut = IPonsCurve(curve).buy{value: s.buy}(s.buy, minOut, msg.sender);
        if (address(this).balance != 0) _pay(msg.sender, address(this).balance);
    }

    /// 12 or 16 characters, each '0' or '1'; returns whether the birth is rare
    function _checkBits(string calldata bits) private pure returns (bool rare) {
        bytes calldata b = bytes(bits);
        if (b.length != BITS && b.length != RARE_BITS) revert BadBits();
        for (uint256 i; i < b.length; i++) if (b[i] != "0" && b[i] != "1") revert BadBits();
        return b.length == RARE_BITS;
    }

    /// the Pons launch: the creator gets the creator fees and is exempt from the snipe tax on its own first buy
    function _launchOnPons(LaunchArgs calldata a, uint256 ponsFee) private returns (address token, address curve) {
        address[] memory exempt = new address[](1);
        exempt[0] = msg.sender;
        (token, curve) = pons.launchToken{value: ponsFee}(
            IPonsFactory.TokenParams({
                name: a.name,
                symbol: a.symbol,
                logo: a.logo,
                description: string.concat(a.description, unicode"\n\nBorn on HubGPU · |", a.bits, unicode"⟩"),
                socials: IPonsFactory.Socials({twitter: a.twitter, telegram: a.telegram, discord: "", website: a.website, farcaster: ""}),
                creatorFeeRecipient: msg.sender,
                creatorTaxBps: a.creatorTaxBps,
                buybackEnabled: false,
                expectedEconomics: a.expectedEconomics,
                salt: a.salt
            }),
            0,
            address(0),
            exempt
        );
    }

    function _pay(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---- views ----

    /// true when the wallet holds enough $HGPU (always false until the owner sets the token)
    function isHolder(address wallet) public view returns (bool) {
        address t = holderToken;
        if (t == address(0) || holderMin == 0) return false;
        try IERC20Balance(t).balanceOf(wallet) returns (uint256 bal) {
            return bal >= holderMin;
        } catch {
            return false;
        }
    }

    /// what this wallet pays HubGPU for a launch right now
    function feeFor(address wallet) public view returns (uint256) {
        return isHolder(wallet) || feeExempt[wallet] ? 0 : launchFee;
    }

    /// everything the page needs for one wallet in one call
    function terms(address wallet) external view returns (uint256 fee, uint256 ponsFee, uint256 minBuy, bool holder, bool isPaused) {
        return (feeFor(wallet), pons.launchFee(), minOpeningBuy, isHolder(wallet), paused);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ---- admin ----

    function setLaunchFee(uint256 fee) external onlyOwner {
        if (fee > MAX_LAUNCH_FEE) revert BadValue();
        launchFee = fee;
        emit LaunchFeeChanged(fee);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasuryChanged(t);
    }

    function setMinOpeningBuy(uint256 amount) external onlyOwner {
        if (amount < MIN_OPENING_BUY_FLOOR || amount > MAX_OPENING_BUY) revert BadValue();
        minOpeningBuy = amount;
        emit MinOpeningBuyChanged(amount);
    }

    /// set once $HGPU exists; min is in the token's smallest unit (1,000,000 $HGPU = 1_000_000e18)
    function setHolderTerms(address token, uint256 min) external onlyOwner {
        holderToken = token;
        holderMin = min;
        emit HolderTermsChanged(token, min);
    }

    function setFeeExempt(address wallet, bool exempt) external onlyOwner {
        feeExempt[wallet] = exempt;
        emit FeeExemptChanged(wallet, exempt);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedChanged(p);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// only the curve's refund of a clamped first buy is accepted, during a launch
    receive() external payable {
        if (_lock != 2) revert BadValue();
    }
}
