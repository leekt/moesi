// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library ArtifactMath {
    function add(uint256 value) external pure returns (uint256) { return value + 1; }
}

contract ArtifactChild {}

contract ArtifactExample {
    address public immutable child;
    address public immutable factory;
    uint256 public immutable seed;

    constructor(uint256 initial) {
        child = address(new ArtifactChild());
        factory = msg.sender;
        seed = initial;
    }

    function plus() external view returns (uint256) { return ArtifactMath.add(seed); }
}
