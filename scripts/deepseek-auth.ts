#!/usr/bin/env bun

import {
    addDeepSeekAccountFromToken,
    addDeepSeekAccountInteractive,
    reloginDeepSeekAccountInteractive,
    removeDeepSeekAccountInteractive,
    runDeepSeekAccountMenu
} from '../src/providers/deepseek/auth.ts';
import { loadDeepSeekAccounts } from '../src/providers/deepseek/accounts.ts';

const args = new Set(process.argv.slice(2));

try {
    if (args.has('--list')) {
        const accounts = loadDeepSeekAccounts();
        if (!accounts.length) console.log('No saved DeepSeek accounts.');
        accounts.forEach((account, index) =>
            console.log(`${index + 1} | ${account.id} | ${account.invalid ? 'Invalid' : 'OK'}`)
        );
    } else if (args.has('--token')) {
        if (args.has('--relogin')) await reloginDeepSeekAccountInteractive(true);
        else await addDeepSeekAccountFromToken();
    } else if (args.has('--add')) {
        await addDeepSeekAccountInteractive();
    } else if (args.has('--relogin')) {
        await reloginDeepSeekAccountInteractive();
    } else if (args.has('--remove')) {
        await removeDeepSeekAccountInteractive();
    } else {
        await runDeepSeekAccountMenu();
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
