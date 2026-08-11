// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract ManagedAttestation {
    address public owner;
    bytes32 public marker;

    constructor() {
        owner = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        marker = 0xabababababababababababababababababababababababababababababababab;
    }
}
