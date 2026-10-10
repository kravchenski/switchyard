import {
    agentSetupHelp,
    installAgentIntegrations,
    loadAvailableModelIds,
    parseAgentSetupArgs
} from '../src/cli/agentSetup.ts';

try {
    const options = parseAgentSetupArgs(process.argv.slice(2));
    if (options.help) {
        console.log(agentSetupHelp());
        process.exit(0);
    }

    const modelIds = await loadAvailableModelIds(options.baseUrl, options.apiKey);
    const results = await installAgentIntegrations(options, modelIds);

    console.log(`${options.dryRun ? 'Planned' : 'Configured'} ${options.agents.length} agent integrations with ${modelIds.length} models.`);
    for (const result of results) {
        const detail = result.detail ? ` (${result.detail})` : '';
        console.log(`- ${result.agent}: ${result.status} ${result.path}${detail}`);
    }
    console.log('\nCodex and Claude Code connect directly to the gateway (Responses and Anthropic Messages). See ~/.freeqwenapi/README.md.');
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
