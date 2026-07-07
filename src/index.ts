import { resolve } from "node:path";
import {
  getChannelConfig,
  getPlaybook,
  loadConfig,
} from "./config.js";
import { decideNextAction, inferProofKindFromCaption } from "./decision-engine.js";

function main() {
  const configPath = resolve(process.cwd(), "config", "bot.config.yaml");
  const config = loadConfig(configPath);

  const channel = getChannelConfig(
    config,
    "069e972b-e3c4-4d14-b716-0c1226bf753c",
  );

  if (!channel) {
    throw new Error("Demo channel not found in config");
  }

  const playbook = getPlaybook(config, channel.country);
  const proofKind = inferProofKindFromCaption(
    playbook,
    "Screenshot with balance after deposit",
  );

  const decision = decideNextAction(config, channel, {
    channelId: channel.id,
    currentStage: "waiting_id",
    latestCustomerText: "I made deposit and sent balance screenshot",
    proofKind,
  });

  console.log(
    JSON.stringify(
      {
        channel: channel.name,
        proofKind,
        decision,
      },
      null,
      2,
    ),
  );
}

main();
