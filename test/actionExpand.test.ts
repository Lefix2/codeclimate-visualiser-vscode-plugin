import { strict as assert } from 'assert';
import { expandActions } from '../src/actionExpand';
import { ActionDefinition } from '../src/types';

describe('expandActions', () => {
  it('expands a dirs template into one action per directory', () => {
    const actions: ActionDefinition[] = [
      {
        id: 'analyze',
        label: 'Analyser ${name}',
        description: 'Analyse ${name}.',
        forEach: { dirs: 'sous-systemes/*', as: 'name' },
        onSave: ['sous-systemes/${name}/**/*.c'],
        then: [{ id: 'run-codeparser', args: ['${name}'] }],
      },
    ];
    const out = expandActions(actions, () => ['archivage', 'acquisitio']);

    assert.equal(out.length, 2);
    // sorted by name
    assert.deepEqual(out.map(a => a.id), ['analyze-acquisitio', 'analyze-archivage']);
    const first = out[0];
    assert.equal(first.label, 'Analyser acquisitio');
    assert.equal(first.description, 'Analyse acquisitio.');
    assert.deepEqual(first.onSave, ['sous-systemes/acquisitio/**/*.c']);
    assert.deepEqual(first.then, [{ id: 'run-codeparser', args: ['acquisitio'] }]);
    assert.equal('forEach' in first, false);
  });

  it('expands a values template and dedupes against dirs', () => {
    const out = expandActions(
      [{ id: 'a', label: 'L ${x}', forEach: { dirs: 'd/*', values: ['b'], as: 'x' } }],
      () => ['b', 'c'],
    );
    assert.deepEqual(out.map(a => a.id), ['a-b', 'a-c']);
  });

  it('rewrites a then-ref to a template id into refs to all its children', () => {
    const actions: ActionDefinition[] = [
      { id: 'analyze', label: '${n}', forEach: { values: ['x', 'y'], as: 'n' } },
      { id: 'all', label: 'All', then: ['analyze'] },
    ];
    const out = expandActions(actions, () => []);
    const all = out.find(a => a.id === 'all')!;
    assert.deepEqual(all.then, ['analyze-x', 'analyze-y']);
  });

  it('leaves non-template actions untouched', () => {
    const actions: ActionDefinition[] = [
      { id: 'plain', label: 'Plain', command: 'echo hi' },
    ];
    const out = expandActions(actions, () => []);
    assert.deepEqual(out, actions);
  });
});
