import { createLocalAnvilFixture } from "@oaath/testing/anvil";

export const fixture = await createLocalAnvilFixture();
let stop = false;
export function stopAfterNextSend() {
  stop = true;
}

// Application-owned composition over public SDK handles. The signal hook
// exercises the CLI's durable boundary; all execution stays inside OAAth.
export async function openOAAth() {
  const oaath = await fixture.openClient();
  return Object.freeze({
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
}
