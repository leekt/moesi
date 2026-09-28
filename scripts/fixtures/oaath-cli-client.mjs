import { createLocalAnvilFixture } from "@oaath/testing/anvil";

export const fixture = await createLocalAnvilFixture({
  stateDirectory: process.env.MOESI_PROCESS_STATE,
  kernelVersion: "0.3.3",
});
const initial = await fixture.openClient();
export const account = Object.freeze({
  kind: "existing",
  address: initial.binding.account.address,
  accountId: "cli-fleet",
});
await fixture.closeClient();
if (process.env.MOESI_PROCESS_STATE)
  process.send({ type: "environment", recovery: fixture.recovery, processIds: fixture.processIds });
let stop = false;
export function stopAfterNextSend() {
  stop = true;
}

// Application-owned composition over public SDK handles. The signal hook
// exercises the CLI's durable boundary; all execution stays inside OAAth.
export async function openOAAth() {
  const oaath = await fixture.openClient();
  return {
    account,
    oaath: Object.freeze({
      ...oaath,
      async connect() {
        const connection = await oaath.connect();
        return Object.freeze({
          ...connection,
          async resume() {
            const grant = await connection.resume();
            if (grant === null) return null;
            return Object.freeze({
              ...grant,
              async sendCalls(input) {
                const operation = await grant.sendCalls(input);
                if (operation.outcome.state !== "submitted")
                  throw new Error("packed_oaath_submission_not_pending");
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
    }),
  };
}
