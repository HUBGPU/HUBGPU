// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Minimal views of the Pons v2 contracts on Robinhood Chain (verified sources on Sourcify, chain 4663).

interface IPonsFactory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function launchFee() external view returns (uint256);
    function feeEscrow() external view returns (address);
    function maxCreatorTaxBps() external view returns (uint256);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken, address[] calldata snipeTaxExemptions)
        external
        payable
        returns (address token, address curve);
}

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sweepFees(uint256 minBuybackTokensOut) external;
    function feeBps() external view returns (uint256);
    function protocolFeeShareBps() external view returns (uint16);
    function quoteFeeBalance() external view returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
}

interface IPonsEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function claim() external returns (uint256 amount);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claimToken(address token) external;
}
