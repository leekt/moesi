object "OpcodeProbe" {
  code {
    let count := calldataload(0)
    mstore(0, 0x20)
    mstore(0x20, count)
    for { let i := 0 } lt(i, count) { i := add(i, 1) } {
      let success := call(100000, add(0xc000, i), 0, 0, 0, 0, 0)
      mstore(add(0x40, mul(i, 0x20)), success)
    }
    return(0, add(0x40, mul(count, 0x20)))
  }
}
