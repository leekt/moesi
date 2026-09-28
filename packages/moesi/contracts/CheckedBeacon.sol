// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";

library ExactRuntime {
    error RuntimeMismatch();

    function check(address target, bytes32 expectedHash) internal view returns (address) {
        if (target.code.length == 0 || target.codehash != expectedHash) revert RuntimeMismatch();
        return target;
    }
}

/// A single-owner beacon whose creation and upgrades require exact implementation code.
contract CheckedBeacon is UpgradeableBeacon {
    error RuntimeHashRequired();

    constructor(address implementation_, address initialOwner, bytes32 implementationHash)
        UpgradeableBeacon(ExactRuntime.check(implementation_, implementationHash), initialOwner) {}

    function upgradeTo(address) public pure override {
        revert RuntimeHashRequired();
    }

    function upgradeToChecked(address nextImplementation, bytes32 implementationHash) external onlyOwner {
        super.upgradeTo(ExactRuntime.check(nextImplementation, implementationHash));
    }
}

/// The constructor checks the beacon and selected implementation before delegation.
contract CheckedBeaconProxy is BeaconProxy {
    error ImplementationMismatch();
    error InitializationRequired();

    constructor(
        address beacon,
        bytes32 beaconHash,
        address initialImplementation,
        bytes32 implementationHash,
        bytes memory initialization
    ) BeaconProxy(checkedBeacon(beacon, beaconHash, initialImplementation, implementationHash), initialization) {
        if (initialization.length < 4) revert InitializationRequired();
    }

    function checkedBeacon(address beacon, bytes32 beaconHash, address implementation_, bytes32 implementationHash)
        private view returns (address)
    {
        ExactRuntime.check(beacon, beaconHash);
        ExactRuntime.check(implementation_, implementationHash);
        if (IBeacon(beacon).implementation() != implementation_) revert ImplementationMismatch();
        return beacon;
    }
}
