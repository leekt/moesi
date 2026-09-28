// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract BeaconVaultV1 {
    address public owner;
    uint256 public value;

    function initialize(address initialOwner, uint256 initialValue) external {
        require(owner == address(0) && initialOwner != address(0));
        owner = initialOwner;
        value = initialValue;
    }

    function setValue(uint256 next) external {
        require(msg.sender == owner);
        value = next;
    }

    function version() external pure virtual returns (uint256) { return 1; }
}

contract BeaconVaultV2 is BeaconVaultV1 {
    function version() external pure override returns (uint256) { return 2; }
}
