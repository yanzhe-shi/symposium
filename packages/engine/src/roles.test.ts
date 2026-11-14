import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Group, Message, RoleInfo } from './protocol.js';
import { formatRoleFile, parseRoleFile, roleIdFor } from './roles.js';
import { createTestApp, type TestApp } from './testing.js';

let t: TestApp;
let group: Group;

beforeEach(async () => {
  t = await createTestApp();
  group = (
    await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Shop', folderPath: join(t.workDir, 'shop') },
    })
  ).json();
});
afterEach(async () => {
  await t.close();
});

const DESIGNER = {
  title: 'UX Designer',
  kind: 'worker',
  summary: 'Designs the screens.',
  text: 'You design the screens.\n\n- Sketch first.',
};

const addRole = (payload: object) => t.request({ method: 'POST', url: '/api/roles', payload });
const roles = async (): Promise<RoleInfo[]> => (await t.request({ url: '/api/roles' })).json();
const hire = (payload: object) =>
  t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/agents`,
    payload: { provider: 'mock', model: 'mock', ...payload },
  });
const say = (body: string) =>
  t.request({ method: 'POST', url: `/api/groups/${group.id}/messages`, payload: { body } });
const settle = () => t.app.symposium.runner.waitForIdle(group.id);
const chat = async (): Promise<Message[]> =>
  (await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })).json();
const team = async (): Promise<Agent[]> =>
  (await t.request({ url: `/api/groups/${group.id}/agents` })).json();

describe('role files', () => {
  it('reads the header lines and the job description', () => {
    const draft = parseRoleFile(
      '\nname: Designer\nKind: Worker\nsummary: Draws.\n\n# Designer\n\nDraw.\n',
    );
    expect(draft).toEqual({
      title: 'Designer',
      kind: 'worker',
      summary: 'Draws.',
      text: '# Designer\n\nDraw.',
    });
    expect(parseRoleFile(formatRoleFile(draft as never))).toEqual(draft);
  });

  it('takes a file without a header as all job description', () => {
    expect(parseRoleFile('# Lead\n\nYou lead.')).toEqual({ text: '# Lead\n\nYou lead.' });
  });

  it('makes an id from a name', () => {
    expect(roleIdFor('  UX Designer! ')).toBe('ux-designer');
  });
});

describe('custom roles', () => {
  it('lists the built-in roles with their job descriptions', async () => {
    const list = await roles();
    expect(list.map((role) => role.id)).toEqual(['lead', 'worker', 'reviewer', 'scribe']);
    expect(list.every((role) => role.builtIn && !role.edited)).toBe(true);
    expect(list[0]!.text).toContain('You lead this team');
  });

  it('adds a role, hires into it and gives the agent its job description', async () => {
    const created = await addRole(DESIGNER);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: 'ux-designer',
      kind: 'worker',
      builtIn: false,
      defaultFiles: 'edit',
      defaultCommands: 'ask',
    });
    expect((await roles()).map((role) => role.id)).toContain('ux-designer');

    const hired = await hire({ name: 'Dee', roleId: 'ux-designer' });
    expect(hired.statusCode).toBe(201);
    // The engine treats Dee as a worker: her own worktree, and commands that ask.
    expect(hired.json()).toMatchObject({
      role: 'worker',
      roleId: 'ux-designer',
      settings: { files: 'edit', commands: 'ask' },
    });
    expect((await chat()).at(-1)!.body).toBe('Dee joined as UX Designer (mock · mock).');

    await say('@Dee draw the cart');
    await settle();
    const prompt = t.mocks.get('Dee')!.calls[0]!.systemPrompt;
    expect(prompt).toContain('You are Dee, the UX Designer of a software team');
    expect(prompt).toContain('- Sketch first.');
    expect(prompt).toContain('- Dee: UX Designer (you)');
    expect(prompt).not.toContain('You build what the lead assigns');
  });

  it('finds a role by its name as well as its id', async () => {
    await addRole(DESIGNER);
    expect((await hire({ name: 'Dee', role: 'ux designer' })).json()).toMatchObject({
      roleId: 'ux-designer',
    });
  });

  it('refuses a role without a name, a description or a known kind, and a second of one name', async () => {
    expect((await addRole({ ...DESIGNER, title: ' ' })).statusCode).toBe(400);
    expect((await addRole({ ...DESIGNER, text: '' })).statusCode).toBe(400);
    expect((await addRole({ ...DESIGNER, kind: 'boss' })).statusCode).toBe(400);
    expect((await addRole({ ...DESIGNER, title: 'Lead' })).statusCode).toBe(409);
    expect((await addRole(DESIGNER)).statusCode).toBe(201);
    expect((await addRole({ ...DESIGNER, title: 'ux designer' })).statusCode).toBe(409);
    expect((await hire({ name: 'Dee', role: 'nobody' })).json().error).toBe(
      'Unknown role "nobody"',
    );
  });

  it('applies an edit from the next turn and keeps the id and the kind', async () => {
    await addRole(DESIGNER);
    await hire({ name: 'Dee', roleId: 'ux-designer' });
    const edited = await t.request({
      method: 'PUT',
      url: '/api/roles/ux-designer',
      payload: { title: 'Product Designer', kind: 'lead', text: 'You design the product.' },
    });
    expect(edited.json()).toMatchObject({
      id: 'ux-designer',
      title: 'Product Designer',
      kind: 'worker',
    });

    await say('@Dee go');
    await settle();
    expect(t.mocks.get('Dee')!.calls[0]!.systemPrompt).toContain('You design the product.');
  });

  it('lets the human rewrite a built-in role and take it back', async () => {
    await hire({ name: 'Lea', role: 'lead' });
    const edited = await t.request({
      method: 'PUT',
      url: '/api/roles/lead',
      payload: { title: 'Boss', text: 'You lead, tersely.' },
    });
    expect(edited.json()).toMatchObject({
      id: 'lead',
      title: 'Lead',
      edited: true,
      text: 'You lead, tersely.',
    });
    await say('Plan');
    await settle();
    expect(t.mocks.get('Lea')!.calls[0]!.systemPrompt).toContain('You lead, tersely.');

    const reset = await t.request({ method: 'DELETE', url: '/api/roles/lead' });
    expect(reset.statusCode).toBe(200);
    const lead = (await roles())[0]!;
    expect(lead.edited).toBe(false);
    expect(lead.text).toContain('You lead this team');
  });

  it("uses the scribe's edited job description", async () => {
    let scribePrompt = '';
    t.mocks.set(
      'Sam',
      new MockAdapter((task) => {
        scribePrompt = task.systemPrompt;
        return { text: '# Shop\n' };
      }),
    );
    await hire({ name: 'Lea', role: 'lead' });
    await hire({ name: 'Sam', role: 'scribe' });
    await t.request({
      method: 'PUT',
      url: '/api/roles/scribe',
      payload: { text: 'Write project.md as a haiku.' },
    });
    await say('Plan');
    await settle();
    expect(scribePrompt).toContain('Write project.md as a haiku.');
  });

  it('keeps a role that someone on a team holds, and lets it go once they left', async () => {
    await addRole(DESIGNER);
    const dee: Agent = (await hire({ name: 'Dee', roleId: 'ux-designer' })).json();
    const refused = await t.request({ method: 'DELETE', url: '/api/roles/ux-designer' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('Dee (Shop) has this role');

    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${dee.id}` });
    expect((await t.request({ method: 'DELETE', url: '/api/roles/ux-designer' })).statusCode).toBe(
      200,
    );
    expect((await roles()).map((role) => role.id)).not.toContain('ux-designer');
    expect((await t.request({ method: 'DELETE', url: '/api/roles/ux-designer' })).statusCode).toBe(
      404,
    );
  });

  it('moves an agent to another role without firing it', async () => {
    await addRole({ ...DESIGNER, kind: 'reviewer' });
    const ada: Agent = (await hire({ name: 'Ada', role: 'worker' })).json();
    const moved = await t.request({
      method: 'PATCH',
      url: `/api/groups/${group.id}/agents/${ada.id}`,
      payload: { roleId: 'ux-designer' },
    });
    expect(moved.json()).toMatchObject({
      role: 'reviewer',
      roleId: 'ux-designer',
      settings: { files: 'read' },
    });
    expect((await chat()).at(-1)!.body).toBe(
      'You changed Ada: role worker → ux-designer, files edit → read, commands ask → off.',
    );
  });

  it('skips a role file that cannot be read', async () => {
    mkdirSync(join(t.dataDir, 'roles'), { recursive: true });
    writeFileSync(join(t.dataDir, 'roles', 'broken.md'), 'kind: wizard\n\nCast spells.\n');
    expect((await roles()).map((role) => role.id)).toEqual([
      'lead',
      'worker',
      'reviewer',
      'scribe',
    ]);
  });
});

describe('roles written by the lead', () => {
  const ROLE_BLOCK =
    '```role\nname: Designer\nkind: worker\nsummary: Designs the screens.\n\nYou design the screens.\n```';
  const HIRE_BLOCK =
    '```hire\n{"name": "Dee", "role": "Designer", "provider": "mock", "model": "mock"}\n```';

  async function leadSays(text: string): Promise<Message[]> {
    t.mocks.set('Lea', new MockAdapter([{ text }]));
    await hire({ name: 'Lea', role: 'lead' });
    await say('We need a designer');
    await settle();
    return chat();
  }

  it('tells the lead which roles exist and how to write one', async () => {
    await addRole(DESIGNER);
    await leadSays('Fine.');
    const prompt = t.mocks.get('Lea')!.calls[0]!.systemPrompt;
    expect(prompt).toContain('  - UX Designer: Designs the screens.');
    expect(prompt).toContain('```role');
  });

  it('proposes the hire with the role, and adds both when the human approves', async () => {
    const messages = await leadSays(`We need a designer.\n\n${ROLE_BLOCK}\n\n${HIRE_BLOCK}`);
    const proposal = messages.find((message) => message.meta?.type === 'hire-proposal')!;
    expect(proposal.body).toBe(
      'Lea proposes hiring Dee as Designer (mock · mock). Lea wrote the role "Designer" for this hire.',
    );
    expect(proposal.meta).toMatchObject({
      status: 'pending',
      hire: { name: 'Dee', role: 'worker', roleId: 'designer' },
      newRole: { title: 'Designer', kind: 'worker', text: 'You design the screens.' },
    });
    // The blocks are not shown as text, and nothing exists until the human says yes.
    expect(messages.find((message) => message.authorKind === 'agent')!.body).toBe(
      'We need a designer.',
    );
    expect((await roles()).map((role) => role.id)).not.toContain('designer');
    expect(existsSync(join(t.dataDir, 'roles', 'designer.md'))).toBe(false);

    const approved = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${proposal.id}/approve-hire`,
    });
    expect(approved.statusCode).toBe(200);
    expect((await roles()).find((role) => role.id === 'designer')).toMatchObject({
      title: 'Designer',
      builtIn: false,
    });
    expect((await team()).find((agent) => agent.name === 'Dee')).toMatchObject({
      role: 'worker',
      roleId: 'designer',
    });
  });

  it('adds nothing when the human declines', async () => {
    const messages = await leadSays(`${ROLE_BLOCK}\n${HIRE_BLOCK}`);
    const proposal = messages.find((message) => message.meta?.type === 'hire-proposal')!;
    await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${proposal.id}/reject-hire`,
    });
    expect((await roles()).map((role) => role.id)).not.toContain('designer');
    expect(await team()).toHaveLength(1);
  });

  it('says so when a role is written but nobody is hired into it', async () => {
    const messages = await leadSays(ROLE_BLOCK);
    expect(messages.at(-1)!.body).toBe(
      'Lea wrote the role "Designer", but no hire in the same message uses it, so it was not added.',
    );
  });

  it('does not let the lead write a second lead or a scribe role', async () => {
    const messages = await leadSays(
      `${ROLE_BLOCK.replace('kind: worker', 'kind: lead')}\n${HIRE_BLOCK}`,
    );
    const notices = messages
      .filter((message) => message.meta?.type === 'notice')
      .map((message) => message.body);
    expect(notices).toContain(
      "Lea wrote a role that can't be used: a role written by the lead works as a worker or as a reviewer",
    );
    expect(notices).toContain('Lea proposed a hire that can\'t be used: Unknown role "Designer"');
    expect(messages.some((message) => message.meta?.type === 'hire-proposal')).toBe(false);
  });
});
