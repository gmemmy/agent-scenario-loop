export type MatchableProfileCommand = {
  command: string;
  commandId?: string;
};

/**
 * Aligns platform command envelopes with portable command policy by stable
 * identity, consuming repeated command occurrences in order.
 */
export function alignProfileCommandsWithPortablePolicy<
  PlatformCommand extends MatchableProfileCommand,
  PlanCommand extends MatchableProfileCommand,
>(
  platform: string,
  commands: readonly PlatformCommand[],
  planCommands: readonly PlanCommand[],
): Array<{ command: PlatformCommand; planCommand: PlanCommand }> {
  const remainingPlanCommands = [...planCommands];
  const aligned = commands.map((command) => {
    if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
      throw new Error(`${platform} profile commands require a stable commandId.`);
    }
    const indexedPlanCommands = remainingPlanCommands.map((planCommand, index) => ({
      index,
      planCommand,
    }));
    const exactIdentityMatches = indexedPlanCommands.filter(({ planCommand }) => (
      command.commandId === planCommand.commandId
    ));

    if (exactIdentityMatches.length === 0) {
      throw new Error(
        `${platform} profile command "${command.commandId}" has no matching portable command policy.`,
      );
    }

    const match = exactIdentityMatches[0];
    if (!match) {
      throw new Error(`${platform} profile command policy matching produced no candidate.`);
    }
    const [planCommand] = remainingPlanCommands.splice(match.index, 1);
    if (!planCommand) {
      throw new Error(`${platform} profile command policy matching lost its selected candidate.`);
    }

    return { command, planCommand };
  });

  if (remainingPlanCommands.length > 0) {
    const missingCommand = remainingPlanCommands[0];
    throw new Error(
      `${platform} platform commands omit portable command policy "${missingCommand?.commandId ?? missingCommand?.command ?? 'unknown'}".`,
    );
  }

  return aligned;
}
