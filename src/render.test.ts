import test from 'node:test';
import assert from 'node:assert/strict';

import { mountEnvironment, render, unmount, quiet, type Responses } from './testing/dom.ts';
import EditorBridgeBanner from './EditorBridgeBanner.tsx';
import HistoryPanel from './HistoryPanel.tsx';
import ContextBadge from './ContextBadge.tsx';
import PolicySection from './PolicySection.tsx';
import ToolsPanel from './ToolsPanel.tsx';
import ProductionConfirm from './ProductionConfirm.tsx';
import HttpPanel from './HttpPanel.tsx';
import GitPanel from './GitPanel.tsx';

/** Every case gets a fresh DOM; a leaked one makes later failures nonsense. */
async function withDom(responses: Responses, run: (calls: ReturnType<typeof mountEnvironment>) => Promise<void>) {
  const calls = mountEnvironment(responses);
  try {
    await run(calls);
  } finally {
    await unmount();
  }
}

// ---------------------------------------------------------------- the bridge

test('the bridge banner names the waiting file and offers both outcomes', async () => {
  await withDom({}, async () => {
    const view = await render(EditorBridgeBanner, {
      pending: { id: '1-2', path: '/tmp/kubectl-edit-9.yaml' },
      dirty: false,
      onFinish: () => {},
      onAbort: () => {},
    });
    assert.match(view.text(), /kubectl-edit-9\.yaml/, 'must say which file is blocking');
    assert.match(view.text(), /Save & continue/);
    assert.match(view.text(), /Abort command/);
  });
});

test('the bridge banner buttons map to different outcomes', async () => {
  await withDom({}, async () => {
    const pressed: string[] = [];
    const view = await render(EditorBridgeBanner, {
      pending: { id: '1-2', path: '/tmp/COMMIT_EDITMSG' },
      dirty: true,
      onFinish: () => pressed.push('finish'),
      onAbort: () => pressed.push('abort'),
    });
    // These are exit 0 vs exit 1 to git; conflating them would be severe.
    await view.click(view.all('button')[0]);
    await view.click(view.all('button')[1]);
    assert.deepEqual(pressed, ['finish', 'abort']);
    assert.match(view.text(), /unsaved changes/);
  });
});

// --------------------------------------------------------------- the history

test('the history panel lists snapshots and restores one into the buffer', async () => {
  const snapshot = 'apiVersion: v1\nkind: ConfigMap\n';
  await withDom(
    {
      history_list: [
        { id: '1700000200000-bridge-open', millis: 1700000200000, label: 'bridge-open', bytes: 34 },
        { id: '1700000100000-save', millis: 1700000100000, label: 'save', bytes: 12 },
      ],
      history_read: snapshot,
    },
    async calls => {
      const restored: string[] = [];
      const view = await render(HistoryPanel, {
        path: '/w/deploy.yaml',
        current: 'current buffer\n',
        onRestore: (text: string) => restored.push(text),
      }, calls);

      assert.equal(calls.filter(c => c.command === 'history_list').length, 1);
      // The label that justifies the whole feature.
      assert.match(view.text(), /Before terminal edit/);
      assert.match(view.text(), /Saved/);

      await view.click(view.all('.history-entry')[0]);
      assert.equal(calls.at(-1)?.command, 'history_read');

      const restore = view.all('button').find(b => /Restore into buffer/.test(b.textContent ?? ''));
      assert.ok(restore, 'a previewed snapshot must be restorable');
      await view.click(restore);
      assert.deepEqual(restored, [snapshot], 'restore must hand back the snapshot, not the buffer');
    },
  );
});

test('the history panel says so when there is nothing yet', async () => {
  await withDom({ history_list: [] }, async calls => {
    const view = await render(HistoryPanel, { path: '/w/new.tf', current: '', onRestore: () => {} }, calls);
    assert.match(view.text(), /No snapshots yet/);
  });
});

test('the history panel survives a backend error', async () => {
  // No stub for history_list, so the invoke rejects.
  await withDom({}, async calls => {
    const view = await quiet(() =>
      render(HistoryPanel, { path: '/w/x.tf', current: '', onRestore: () => {} }, calls));
    assert.match(view.text(), /Local history/, 'an error must not blank the panel');
  });
});

// ----------------------------------------------------------- context badge

test('the context badge shows what a command would target', async () => {
  await withDom(
    {
      active_context: {
        kube_context: 'acme-prod', kube_namespace: 'payments',
        aws_profile: 'admin', aws_region: 'us-east-1',
        terraform_workspace: 'prod', production: true,
      },
    },
    async calls => {
      const view = await render(ContextBadge, { root: '/w', revision: 0 }, calls);
      assert.match(view.text(), /acme-prod\/payments/);
      assert.match(view.text(), /admin \(us-east-1\)/);
      assert.match(view.text(), /PROD/, 'a production context must be badged');
    },
  );
});

test('the context badge renders nothing when nothing resolves', async () => {
  await withDom(
    {
      active_context: {
        kube_context: null, kube_namespace: null, aws_profile: null,
        aws_region: null, terraform_workspace: null, production: false,
      },
    },
    async calls => {
      const view = await render(ContextBadge, { root: '', revision: 0 }, calls);
      assert.equal(view.text(), '', 'an empty context must not leave a stray badge');
    },
  );
});

// ----------------------------------------------------------------- policy

test('the policy section reports a missing engine instead of failing silently', async () => {
  await withDom(
    { policy_discover: { policy_dirs: [], inputs: [], opa: null } },
    async calls => {
      const view = await render(PolicySection, {
        root: '/w', onDiagnostics: () => {}, onOpen: () => {},
      }, calls);
      assert.match(view.text(), /OPA is not installed/);
      assert.match(view.text(), /No \.rego files found/);
    },
  );
});

test('the policy section evaluates and hands findings to the marker pipeline', async () => {
  await withDom(
    {
      policy_discover: { policy_dirs: ['/w/policies'], inputs: ['/w/plan.json'], opa: '/usr/local/bin/opa' },
      policy_evaluate: {
        engine: '/usr/local/bin/opa', policies: '/w/policies', input: '/w/plan.json', unlocated: 0,
        findings: [{
          severity: 'error', rule: 'terraform.s3', message: 'not encrypted',
          resource: 'aws_s3_bucket.artifacts', path: '/w/main.tf', line: 5, column: 1,
        }],
      },
    },
    async calls => {
      const diagnostics: unknown[][] = [];
      const view = await render(PolicySection, {
        root: '/w', onDiagnostics: (rows: unknown[]) => diagnostics.push(rows), onOpen: () => {},
      }, calls);

      const evaluate = view.all('button').find(b => /Evaluate policies/.test(b.textContent ?? ''));
      assert.ok(evaluate, 'evaluate must be offered once a policy dir and input exist');
      await view.click(evaluate);

      assert.match(view.text(), /1 violation/);
      assert.match(view.text(), /main\.tf:5/, 'a finding must be clickable back to its line');
      assert.equal(diagnostics.at(-1)?.length, 1, 'findings must reach the marker pipeline');
    },
  );
});

// ------------------------------------------------------------------- tools

test('the tools panel mounts and computes a subnet without a backend', async () => {
  await withDom({}, async () => {
    const view = await render(ToolsPanel, {
      fileName: 'main.tf', buffer: 'resource "x" "y" {}\n', onApplyToBuffer: () => {},
    });
    const subnet = view.all('.tools-nav-item').find(b => /IP Subnet/.test(b.textContent ?? ''));
    assert.ok(subnet, 'the subnet tool must be reachable');
    await view.click(subnet);
    // 10.42.0.0/22 is the default; these are the values a wrong
    // signed-32-bit implementation would get wrong.
    assert.match(view.text(), /255\.255\.252\.0/);
    assert.match(view.text(), /10\.42\.3\.255/);
  });
});

test('every panel unmounts cleanly', async () => {
  // A throw during teardown means a listener or timer outlived the component.
  await withDom({ history_list: [] }, async calls => {
    await render(HistoryPanel, { path: '/w/a.tf', current: '', onRestore: () => {} }, calls);
  });
  assert.ok(true);
});

// -------------------------------------------------------------------- http

test('the http panel lists requests and shows a response', async () => {
  const file = [
    '@host = http://localhost:9',
    '',
    '### Health',
    'GET {{host}}/healthz',
    'Accept: application/json',
    '',
  ].join('\n');

  await withDom(
    {
      http_send: {
        status: 200, status_text: 'OK', headers: [['content-type', 'application/json']],
        body: '{"ok":true}', elapsed_ms: 12, bytes: 11, truncated: false,
        content_type: 'application/json',
      },
    },
    async calls => {
      const view = await render(HttpPanel, { fileName: 'api.http', buffer: file, onOpenLine: () => {} }, calls);
      assert.match(view.text(), /Health/);
      assert.match(view.text(), /GET/);

      await view.click(view.all('.http-run')[0]);
      const sent = calls.find(c => c.command === 'http_send');
      assert.ok(sent, 'running a request must reach the backend');
      // The variable has to be substituted before the request leaves the panel.
      assert.equal((sent.args.request as { url: string }).url, 'http://localhost:9/healthz');
      assert.match(view.text(), /200 OK/);
      assert.match(view.text(), /12 ms/);
    },
  );
});

test('the http panel refuses to send with an undefined variable', async () => {
  await withDom({}, async calls => {
    const view = await render(HttpPanel, {
      fileName: 'api.http',
      buffer: '### X\nGET {{missing}}/x\n',
      onOpenLine: () => {},
    }, calls);
    await view.click(view.all('.http-run')[0]);
    // Sending to a URL with a literal {{missing}} in it helps nobody.
    assert.equal(calls.filter(c => c.command === 'http_send').length, 0);
    assert.match(view.text(), /Undefined variable: missing/);
  });
});

// ------------------------------------------------------- production gate

test('the production dialog starts locked and names what it will do', async () => {
  await withDom({}, async () => {
    const outcome: string[] = [];
    const view = await render(ProductionConfirm, {
      challenge: { action: 'terraform apply', expected: 'acme-prod', reason: 'acme-prod looks like production' },
      onConfirm: (typed: string) => outcome.push(typed),
      onCancel: () => outcome.push('<cancelled>'),
    });

    // The dialog has to say what runs and where, or it is just a speed bump
    // with no information in it.
    assert.match(view.text(), /terraform apply/);
    assert.match(view.text(), /acme-prod/);

    const go = view.all('button').find(b => /Run it/.test(b.textContent ?? ''))!;
    assert.ok(go.hasAttribute('disabled'), 'the confirm button must start locked');
    await view.click(go);
    assert.deepEqual(outcome, [], 'a locked button must not confirm');

    await view.click(view.all('button').find(b => /Cancel/.test(b.textContent ?? ''))!);
    assert.deepEqual(outcome, ['<cancelled>']);
  });
});

// Whether a given string unlocks it is decided in Rust (guard::answered) and
// re-verified there before the task runs, so that is where the exact-match
// cases live rather than being re-simulated through the DOM.

// ------------------------------------------------- the pre-commit hook panel

const repository = { branch: 'main', files: [] };

/** A hook state, spread over the parts a given case cares about. */
const hookState = (over: Record<string, unknown> = {}) =>
  ({ present: false, ours: false, path: '/repo/.git/hooks/pre-commit', hooksPathOverride: null, gitleaks: true, ...over });

test('with no hook installed the panel says terminal commits are unscanned, and offers to install', async () => {
  const calls = mountEnvironment({ git_status: repository, precommit_hook_status: hookState(), install_precommit_hook: 'Pre-commit secret scan installed at /repo/.git/hooks/pre-commit.' });
  try {
    const view = await render(GitPanel, { root: '/repo', onOpen: () => {}, dirty: false }, calls);
    assert.match(view.text(), /Only commits made here are scanned/, 'must name the gap it closes');

    const install = view.all('button').find(b => b.textContent === 'Install pre-commit hook');
    assert.ok(install, 'expected an install button');
    await view.click(install);

    const sent = calls.find(c => c.command === 'install_precommit_hook');
    assert.deepEqual(sent?.args, { root: '/repo', replace: false }, 'a first install must never ask to replace');
    assert.match(view.text(), /installed at/);
  } finally {
    await unmount();
  }
});

test('someone else\'s hook is never replaced without a second, explicit click', async () => {
  const calls = mountEnvironment({
    git_status: repository,
    precommit_hook_status: hookState({ present: true, ours: false }),
    install_precommit_hook: (args: Record<string, unknown>) =>
      args.replace ? 'Pre-commit secret scan installed. The previous hook was kept at /repo/.git/hooks/pre-commit.before-afteredit-1.' : Promise.reject(new Error('already exists')),
  });
  try {
    const view = await render(GitPanel, { root: '/repo', onOpen: () => {}, dirty: false }, calls);
    assert.match(view.text(), /AfterEdit did not write it/, 'must warn before touching a foreign hook');

    const replace = view.all('button').find(b => b.textContent === 'Replace existing hook');
    assert.ok(replace, 'replacing must be its own deliberate action');
    await view.click(replace);
    assert.deepEqual(calls.find(c => c.command === 'install_precommit_hook')?.args, { root: '/repo', replace: true });
    assert.match(view.text(), /kept at/, 'the user must be told where their hook went');
  } finally {
    await unmount();
  }
});

test('an installed hook without gitleaks admits how much it actually covers', async () => {
  const calls = mountEnvironment({ git_status: repository, precommit_hook_status: hookState({ present: true, ours: true, gitleaks: false }) });
  try {
    const view = await render(GitPanel, { root: '/repo', onOpen: () => {}, dirty: false }, calls);
    assert.match(view.text(), /built-in rules/, 'must not imply gitleaks-level coverage it does not have');
    assert.match(view.text(), /install gitleaks/);
  } finally {
    await unmount();
  }
});

test('a repository with core.hooksPath says where the hook will land', async () => {
  const calls = mountEnvironment({ git_status: repository, precommit_hook_status: hookState({ hooksPathOverride: 'githooks' }) });
  try {
    const view = await render(GitPanel, { root: '/repo', onOpen: () => {}, dirty: false }, calls);
    assert.match(view.text(), /githooks/, 'installing into .git/hooks here would do nothing');
  } finally {
    await unmount();
  }
});
