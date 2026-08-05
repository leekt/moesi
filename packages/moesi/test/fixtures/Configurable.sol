// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract Configurable {
    uint256 public value;

    function setValue(uint256 nextValue) external {
        value = nextValue;
    }
}
