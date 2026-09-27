# Spec: config
# Version: 1.0 - NEW
# Read along with ARCHITECTURE.md (§4 instance_id)

## Goal
`freeagent.config.json` is a single configuration point common to the CLI and extension. First run procedure that associates both sides with the same folder.

## Output
```jsonc
{
  "version": 1,
  "project_root": ".",
  "context_threshold_pct": 60, // threshold for switching to backup
  "backoff_ms": [30000, 60000, 120000],
  "init_timeout_ms": 60000,
  "test_timeout_ms": 120000,
  "self_assessment_threshold": 70,
  "mode": "plan",                      // plan | yolo
  "auto_backup": true, // recommended enabled
  "git_checkpoints": true,
  "checkpoint_branch": false,
  "registry_url": "https://raw.githubusercontent.com/<repo>/main/llm_adapter_registry.json",
  "registry_check_hours": 24,
  "known_instances": {
    "browser_a1b2c3": { "label": "Chrome - main", "last_seen": "..." }
  }
}
```

## Contract

### Linking the CLI and extensions
Both sides work with the same project folder, but arrive at it differently:
- CLI - via the working directory (`freeagent init`)
- extension - via `showDirectoryPicker`

Match checking: `freeagent init` writes the `project_id` (UUID) marker to the config. After selecting a folder, the extension reads the config and shows `project_id` and the label. If there is no config, a warning that the folder has not been initialized by the CLI.

### `known_instances`
The CLI maintains a list of visible instances with human-readable labels that are specified by the user (“Chrome is the main one,” “Opera is the second Kimi”). The `instance_id`-UUID needs to be readable in the output of `freeagent agents`.

## Constraints
- Config writes CLI; the extension reads and can request the change via a message
- Default values ​​work without editing - the config is optional to start
- `context_threshold_pct` and `backoff_ms` **require calibration on real services** - default values ​​are an initial approximation
- Unknown fields in the config are saved when overwritten (forward compatibility)

## Dependencies
`spec_fs_folder_access`

## Tests
### Unit
1. Missing config → all default values, work is not blocked
2. Partial config → missing fields from defaults
3. Unknown field is retained when overwritten
4. `project_id` matches between CLI and extension → connection confirmed
5. Folder without config selected in extension → warning

### Integration check
`freeagent init` in the new folder → select it in the extension → both sides show the same `project_id`

### Definition of done
- Tests are green
- Running integration checks of previous PRs
