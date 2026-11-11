// Keep tests independent of the developer's git config (identity, signing, hooks).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
