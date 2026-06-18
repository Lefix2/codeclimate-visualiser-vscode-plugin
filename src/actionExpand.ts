import { ActionDefinition, ActionThenRef } from './types';

/** Resolves a `forEach.dirs` glob to the basenames of matching directories. */
export type DirResolver = (glob: string) => string[];

/** Substitute every `${name}` placeholder in any string field of a serialisable value. */
function substitutePlaceholder<T>(value: T, varName: string, replacement: string): T {
  const token = '${' + varName + '}';
  const json = JSON.stringify(value);
  return JSON.parse(json.split(token).join(replacement)) as T;
}

function bindingsFor(spec: ActionDefinition['forEach'], resolve: DirResolver): string[] {
  if (!spec) return [];
  const names = new Set<string>();
  for (const v of spec.values ?? []) names.add(v);
  if (spec.dirs) for (const d of resolve(spec.dirs)) names.add(d);
  return [...names].sort();
}

/**
 * Expand templated (`forEach`) actions into concrete ones.
 *
 * - Each template produces one child per binding, id `${template.id}-${name}`, with `${as}`
 *   substituted in all string fields. The template itself is dropped from the output.
 * - Any `then` ref (in a kept action or a generated child) pointing at a template id is
 *   rewritten to refer to every child of that template, so chaining a template runs them all.
 */
export function expandActions(actions: ActionDefinition[], resolve: DirResolver): ActionDefinition[] {
  const templateChildIds = new Map<string, string[]>();
  const result: ActionDefinition[] = [];

  for (const action of actions) {
    if (!action.forEach) continue;
    const childIds: string[] = [];
    for (const name of bindingsFor(action.forEach, resolve)) {
      const { forEach, ...rest } = action;
      const child = substitutePlaceholder(rest, forEach!.as, name);
      child.id = `${action.id}-${name}`;
      // Children of a template share a group (so the Actions tab clusters them and can
      // run the whole template at once). Default to the template id unless groups were set.
      if (child.groups === undefined) child.groups = [action.id];
      childIds.push(child.id);
      result.push(child);
    }
    templateChildIds.set(action.id, childIds);
  }

  const expandThen = (then?: ActionThenRef[]): ActionThenRef[] | undefined => {
    if (!then) return then;
    const out: ActionThenRef[] = [];
    for (const ref of then) {
      const id = typeof ref === 'string' ? ref : ref.id;
      const children = templateChildIds.get(id);
      if (children) out.push(...children);
      else out.push(ref);
    }
    return out;
  };

  // Non-template actions, with then-refs to templates rewritten to their children.
  for (const action of actions) {
    if (action.forEach) continue;
    result.push(action.then ? { ...action, then: expandThen(action.then) } : action);
  }

  // Children may also chain templates (e.g. via the template's own `then`).
  for (let i = 0; i < result.length; i++) {
    if (result[i].then) result[i] = { ...result[i], then: expandThen(result[i].then) };
  }

  return result;
}
