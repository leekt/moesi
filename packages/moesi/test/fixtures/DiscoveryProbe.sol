// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// A read-evidence fixture, not a delegating proxy or an access-control implementation.
contract DiscoveryProbe {
    address public owner;
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 private constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    constructor() {
        owner = msg.sender;
        assembly {
            sstore(IMPLEMENTATION_SLOT, 0xcccccccccccccccccccccccccccccccccccccccc)
            sstore(ADMIN_SLOT, caller())
        }
    }

    function implementation() external pure returns (address) {
        return 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return role == bytes32(uint256(1)) && account == owner;
    }

    function getRoleAdmin(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function beaconMode() external {
        require(msg.sender == owner);
        assembly {
            sstore(IMPLEMENTATION_SLOT, 0)
            sstore(BEACON_SLOT, address())
        }
    }

    function changeOwner(address next) external {
        require(msg.sender == owner);
        owner = next;
    }
}
