# Spec: context privacy filter
# Version: 1.0
# Read with ARCHITECTURE.md (§11, §6)

#Goal
The secrets of the user’s project do not go into the context of free LLMs. The filter is used for reading (before sending the content to the agent) and for recording the project tree (before sending it to the orchestrator).

#Input
The contents of the file requested by the agent through READ
Project tree sent to the orchestrator
- exclude-config `.freeagentignore` + built-in rules

#Output
Filtered content: secret values replaced by `[REDACTED]`
Filtered tree: Excluded files are not visible
CLI warning at each operation (user knows the filter is working)

##Contract ##

### Two layers of filtration

*Layer 1 – exclude files entirely.** The file is not sent to the agent or seen in the tree.

Built-in list (unedited):
```
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
.npmrc (if _authToken)
```User `.freeagentignore` (`.gitignore` format):
```
# case
secrets/
config/production.yaml
*.credentials
```**Layer 2 – masking inside permitted files.**Secret-like lines are replaced with `[REDACTED: <type>]`.

Patterns (regular expressions):
API keys: strings of the form `sk-`, `pk_`, `AKIA`, `ghp_`, `glpat-`, long base64 blocks after `=` or `:`
- connection strings: `postgres://`, `mysql://`, `mongodb://`, `redis://` with credentials
- bearer tokens: `Bearer <token>`
- environment variables: `process.env.SECRET_NAME` → name visible, no value (no value in code, but `.env` - yes)

##### What's NOT filtered
File and variable names (the agent needs to know that `DATABASE_URL` exists to use it by name)
Test/fake data (there is no reliable way to distinguish `test_key_123` from the real key – false positives are permissible, it is better to be safe)
Code – only what looks like a secret ** value** is filtered, not like a language construct.

##Constraints
- The filter is executed **in CLI** before sending the contents to the bus - single point
The filter **n** applies to write to disk (`WRITE`) - the agent writes what he wants, it is his code.
`.freeagentignore` is read at the start of the CLI and when changed (fs.watch)
In the absence of `.freeagentignore`, only the built-in rules work.
False positive is better than a pass: if doubtful – to mask, the user will see a warning
- For opensource project, this is **reputation requirement #1** - leaking keys through a free LLM service = lost trust

## Dependencies
`spec_file_access` (filter called during READ processing), `spec_cli`

## Tests
################################################################################################################################################################################################################################################################
1. `.env` with `DATABASE_URL=postgres://user:pass@host/db` → the entire file is excluded from READ
2. `config.ts` with `const API_KEY = "sk-abc123..."` → `[REDACTED: api_key]`, the rest of the code is intact
3. `config.ts` with `const API_KEY = process.env.API_KEY` → not filtered (no matter)
4. `.freeagentignore` with `secrets/` → files in `secrets/` are not visible in the tree and are not available on READ
5. Project tree: `.env` and `*.pem` are missing in the output
6. Warning in CLI at each trigger (X file filtered/N lines masked)
7. Without `.freeagentignore`, the built-in rules work
8. `test.env.example` with `DATABASE_URL=your_url_here` → masked (better be safe)

###Integration check
Project with `.env`, `secrets/api.key`, `src/config.ts` (contains an API key) → agent makes a READ on each → `.env` rejected, `api.key` rejected, `config.ts` obtained from `[REDACTED]`, CLI showed 3 warning

###Definition of done
- The tests are green.
No secret got into the incoming/tyre during regular work
- Run integration checks of previous PR
