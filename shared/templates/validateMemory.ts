// validateMemory (spec_md_memory_template): проверка полноты MEMORY.md. Pure — без fs, годится
// и для CLI, и для инлайна в браузерный бандл.

export interface MemoryValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_SECTIONS = ['Current state', 'Next steps'];
const MAX_LENGTH = 4000;
const NESTED_FENCE_RE = /^`{4,}/m;

function hasSection(md: string, name: string): boolean {
  return new RegExp(`^##\\s+${name}\\s*$`, 'm').test(md);
}

export function validateMemory(md: string): MemoryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!hasSection(md, section)) errors.push(`missing required section: ${section}`);
  }

  if (md.length > MAX_LENGTH) {
    warnings.push(`memory exceeds ${MAX_LENGTH} chars (${md.length})`);
  }

  if (NESTED_FENCE_RE.test(md)) {
    warnings.push('nested code fence deeper than one level');
  }

  return { ok: errors.length === 0, errors, warnings };
}
