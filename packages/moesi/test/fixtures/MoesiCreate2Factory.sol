// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract MoesiCreate2Factory {
    error DeploymentFailed();

    function deploy(bytes32 salt, bytes memory initCode) external payable returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create2(callvalue(), add(initCode, 0x20), mload(initCode), salt)
        }
        if (deployed == address(0)) revert DeploymentFailed();
    }
}
