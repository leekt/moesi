import { createLocalOwnerAnvilFixture } from "@oaath/testing/anvil";

export const fixture = await createLocalOwnerAnvilFixture({ wallet: "browser", bundler: "reject" });
let stop = false;
let withWallet = true;
export function stopAfterNextSend() {
  stop = true;
}
export function removeWallet() {
  withWallet = false;
}
export async function openOAAth() {
  const sdk = await fixture.openClient();
  const oaath = Object.freeze({
    ...sdk,
    account(address) {
      const account = sdk.account(address);
      return Object.freeze({
        ...account,
        owner(wallet) {
          const handle = account.owner(wallet);
          return Object.freeze({
            ...handle,
            async sendCalls(input) {
              const operation = await handle.sendCalls(input);
              if (stop) {
                stop = false;
                process.emit("SIGINT");
              }
              return operation;
            },
          });
        },
      });
    },
  });
  return {
    oaath,
    account: { address: fixture.address },
    ...(withWallet ? { owner: fixture.wallet } : {}),
  };
}
