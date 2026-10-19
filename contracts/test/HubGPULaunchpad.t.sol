// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HubGPULaunchpad} from "../src/HubGPULaunchpad.sol";
import {IPonsFactory} from "../src/IPons.sol";

interface IToken {
    function balanceOf(address) external view returns (uint256);
    function description() external view returns (string memory);
}

/// stands in for $HGPU: only balanceOf matters to the launchpad
contract MockHGPU {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
}

/// Runs against a fork of Robinhood Chain mainnet: the real Pons factory launches the tokens.
///   forge test --fork-url robinhood -vv
contract HubGPULaunchpadTest is Test {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    HubGPULaunchpad lp;
    MockHGPU hgpu;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address holder = makeAddr("holder");
    uint256 ponsFee;
    uint256 constant FEE = 0.001 ether;
    uint256 constant BUY = 0.0001 ether;

    function setUp() public {
        lp = new HubGPULaunchpad(PONS, owner, treasury, FEE);
        hgpu = new MockHGPU();
        ponsFee = IPonsFactory(PONS).launchFee();
        vm.deal(creator, 10 ether);
        vm.deal(holder, 10 ether);
    }

    function _args(string memory sym, string memory bits) internal pure returns (HubGPULaunchpad.LaunchArgs memory) {
        return HubGPULaunchpad.LaunchArgs({
            name: "Schrodinger Cat",
            symbol: sym,
            logo: "ipfs://bafkreicrlqrgr3jvitx2247e7e57xo7zedopwgfsujaiwg3u7getf76epe",
            description: "Born from one measurement.",
            twitter: "https://x.com/hubgpunetwork",
            telegram: "https://t.me/hubgpu",
            website: "https://hubgpu.network/born/0123456789abcdef",
            bits: bits,
            salt: keccak256(bytes(sym)),
            expectedEconomics: bytes32(0),
            minTokensOut: 0,
            creatorTaxBps: 0
        });
    }

    function _holderTerms() internal {
        hgpu.mint(holder, 1_000_000e18);
        vm.prank(owner);
        lp.setHolderTerms(address(hgpu), 1_000_000e18);
    }

    function test_launchPaysFeeToTreasuryAndWritesBirth() public {
        uint256 t0 = treasury.balance;
        vm.prank(creator);
        (address token, address curve, uint256 out) = lp.launch{value: ponsFee + FEE + BUY}(_args("SCAT", "011010000100"));
        assertEq(treasury.balance - t0, FEE, "fee to treasury");
        assertGt(out, 0);
        assertEq(IToken(token).balanceOf(creator), out, "first buy lands in the creator's wallet");
        assertEq(IToken(token).description(), unicode"Born from one measurement.\n\nBorn on HubGPU · |011010000100⟩");
        IPonsFactory.LaunchedToken memory info = IPonsFactory(PONS).getLaunchedToken(token);
        assertEq(info.creatorFeeRecipient, creator, "creator fees go to the creator");
        assertEq(info.curve, curve);
        assertEq(lp.creatorOf(token), creator);
        assertEq(address(lp).balance, 0, "keeps nothing");
    }

    function test_holderLaunchesFree() public {
        _holderTerms();
        assertEq(lp.feeFor(holder), 0);
        assertEq(lp.feeFor(creator), FEE);
        uint256 t0 = treasury.balance;
        vm.prank(holder);
        lp.launch{value: ponsFee + BUY}(_args("FREE", "000011110000"));
        assertEq(treasury.balance, t0, "holder pays nothing");
    }

    function test_rareBirthNeedsHolder() public {
        vm.prank(creator);
        vm.expectRevert(HubGPULaunchpad.RareNeedsHolder.selector);
        lp.launch{value: ponsFee + FEE + BUY}(_args("RARE", "1010100010011110"));

        _holderTerms();
        vm.prank(holder);
        (address token,,) = lp.launch{value: ponsFee + BUY}(_args("RARE", "1010100010011110"));
        assertEq(IToken(token).description(), unicode"Born from one measurement.\n\nBorn on HubGPU · |1010100010011110⟩");
    }

    function test_holderBelowMinimumPays() public {
        hgpu.mint(creator, 999_999e18);
        vm.prank(owner);
        lp.setHolderTerms(address(hgpu), 1_000_000e18);
        assertFalse(lp.isHolder(creator));
        assertEq(lp.feeFor(creator), FEE);
    }

    function test_badBitsRejected() public {
        vm.startPrank(creator);
        vm.expectRevert(HubGPULaunchpad.BadBits.selector);
        lp.launch{value: ponsFee + FEE + BUY}(_args("BAD1", "01101000010"));
        vm.expectRevert(HubGPULaunchpad.BadBits.selector);
        lp.launch{value: ponsFee + FEE + BUY}(_args("BAD2", "011010000102"));
        vm.expectRevert(HubGPULaunchpad.BadBits.selector);
        lp.launch{value: ponsFee + FEE + BUY}(_args("BAD3", "0110100001001"));
        vm.stopPrank();
    }

    function test_firstBuyRequired() public {
        vm.prank(creator);
        vm.expectRevert(HubGPULaunchpad.FirstBuyRequired.selector);
        lp.launch{value: ponsFee + FEE + BUY - 1}(_args("POOR", "011010000100"));
    }

    function test_extraValueBecomesPartOfTheBuy() public {
        vm.prank(creator);
        (address token,, uint256 out) = lp.launch{value: ponsFee + FEE + 0.01 ether}(_args("MORE", "011010000100"));
        assertEq(IToken(token).balanceOf(creator), out);
        assertGt(out, 1_000_000e18, "0.01 ETH buys over a million tokens");
        assertEq(address(lp).balance, 0);
    }

    function test_feeIsCappedAndOwnerOnly() public {
        vm.prank(creator);
        vm.expectRevert(HubGPULaunchpad.NotOwner.selector);
        lp.setLaunchFee(0);
        vm.prank(owner);
        vm.expectRevert(HubGPULaunchpad.BadValue.selector);
        lp.setLaunchFee(0.0101 ether);
        vm.prank(owner);
        lp.setLaunchFee(0.002 ether);
        assertEq(lp.feeFor(creator), 0.002 ether);
    }

    function test_feeExemptWallet() public {
        vm.prank(owner);
        lp.setFeeExempt(creator, true);
        uint256 t0 = treasury.balance;
        vm.prank(creator);
        lp.launch{value: ponsFee + BUY}(_args("TEAM", "011010000100"));
        assertEq(treasury.balance, t0);
    }

    function test_pause() public {
        vm.prank(owner);
        lp.setPaused(true);
        vm.prank(creator);
        vm.expectRevert(HubGPULaunchpad.LaunchesPaused.selector);
        lp.launch{value: ponsFee + FEE + BUY}(_args("STOP", "011010000100"));
    }

    function test_termsView() public {
        _holderTerms();
        (uint256 fee, uint256 pf, uint256 minBuy, bool isH, bool p) = lp.terms(holder);
        assertEq(fee, 0); assertEq(pf, ponsFee); assertEq(minBuy, BUY); assertTrue(isH); assertFalse(p);
        (fee,,, isH,) = lp.terms(creator);
        assertEq(fee, FEE); assertFalse(isH);
    }

    function test_rejectsDirectEth() public {
        vm.prank(creator);
        (bool ok,) = address(lp).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(owner);
        lp.transferOwnership(next);
        assertEq(lp.owner(), owner);
        vm.prank(next);
        lp.acceptOwnership();
        assertEq(lp.owner(), next);
    }

    function test_constructorRejectsFeeAboveCap() public {
        vm.expectRevert(HubGPULaunchpad.BadValue.selector);
        new HubGPULaunchpad(PONS, owner, treasury, 0.02 ether);
    }
}
