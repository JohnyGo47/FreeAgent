# Spec: fs folder access
# Version: 2.0
# Read with ARCHITECTURE.md (§4 bus structure)

#Goal
Access to the extension to the project folder through the FSA, persistence of the resolution between sessions, idempotent creation of the service structure.

#Input
User Click (`showDirectoryPicker()` requires user gesture)
- IndexedDB expansion

#Output
`FileSystemDirectoryHandle` root, available to all modules through a single service
- Structure:
```
/freeagent/
  message_bus.jsonl
  freeagent.config.json
  agents_registry.json
  llm_adapter_registry.json
  selector_overrides.json
  checkpoints.json
  incoming/           ← <instance_id>.jsonl
  commands/           ← <instance_id>.jsonl
  cursors/
  memory/             ← <agent_id>.md
  skills/
  logs/
```##Constraints
Handle is saved **in IndexedDB** - the only storage experiencing a browser restart for FSA-handles. `chrome.storage` doesn't know how to do it.
- At launch: `queryPermission({mode:'readwrite'})` → `'prompt'` → “Restore access” button → `requestPermission()` by click
Creating a structure is idempotent, existing files are not overwritten
All modules receive handle via `FolderAccessService` – no one calls the picker on their own
- Access withdrawn during operation → typed error `FolderAccessLost`, `NOTIFY`, banner in UI
- `showDirectoryPicker` is available from popup/options/offscreen, **not from service worker**

## Dependencies
`spec_ext_manifest`

## Implementation notes
```typescript
class FolderAccessService {
  private handle: FileSystemDirectoryHandle | null = null;
  async pickFolder(): Promise<void> {           // only user gesture
    this.handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbSet('projectRoot', this.handle);
    await this.ensureStructure();
  }
  async restore(): Promise<'granted' | 'prompt' | 'none'> { /* ... */ }
  async ensureStructure(): Promise<void> { /* idempotently */ }
  root(): FileSystemDirectoryHandle { /* throw FolderAccessLost if null */ }
}
````resolvePath(root, "incoming/browser_a1b2c3.jsonl")` is a series of `getDirectoryHandle`/`getFileHandle`, `{create:true}` for service files only.

## Tests
################################################################################################################################################################################################################################################################
1. `ensureStructure` creates the entire tree on an empty folder; a re-call does not overwrite
2. `restore` without saved handle → `'none'`
3. `restore` at `granted` service is ready without dialogue
4. `FolderAccessLost`, not generic exception
5. `resolvePath` creates subdirectories only with `create:true`
6. All 12 positions of the structure are created

###Integration check
Select folder → restart browser → access restored in a maximum of one click → entry in incoming works

###Definition of done
Tests are green, manual check in Chrome
No module addresses the FSA past `FolderAccessService`
- Run integration checks of previous PR
