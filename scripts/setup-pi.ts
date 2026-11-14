import {
    installAgentIntegrations,
    loadAvailableModels,
    parseAgentSetupArgs,
    type AgentSetupOptions
} from '../src/cli/agentSetup.ts';

const requested = parseAgentSetupArgs(process.argv.slice(2));
const options: AgentSetupOptions = { ...requested, agents: ['pi'] };
const { ids: models, images } = await loadAvailableModels(options.baseUrl, options.apiKey);
const [result] = await installAgentIntegrations(options, models, images);

console.log(`Pi provider "freeai" with ${models.length} models: ${result.status} ${result.path}`);
