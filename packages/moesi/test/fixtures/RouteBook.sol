// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RouteBook {
    mapping(bytes32 => uint8) private decimals;
    uint256 public writes;
    uint256 public rowsWritten;

    function checkTargetToken(uint256 chain, address source, address target) external view returns (uint8) {
        return decimals[keccak256(abi.encode(chain, source, target))];
    }

    function setTargetTokens(uint256[] calldata chains, address[] calldata sources, address[] calldata targets, uint8[] calldata values) external {
        require(chains.length == sources.length && chains.length == targets.length && chains.length == values.length);
        ++writes;
        rowsWritten += chains.length;
        for (uint256 i; i < chains.length; ++i) {
            decimals[keccak256(abi.encode(chains[i], sources[i], targets[i]))] = values[i];
        }
    }
}
