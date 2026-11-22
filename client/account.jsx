import { useRef, useState } from 'react';
import { Avatar, LoginBrand, Pill } from './Brand.jsx';
import { api, post, patch, queryString, useJson } from './api.js';
import { ErrorText, Facts, Field, formData, Modal, roleLabel, useTask, when } from './ui.jsx';

export function roleSummary(user) {
  const title =
    user.role === 'ADMINISTRATOR'
      ? user.title
      : user.role === 'TECHNICIAN' && user.teamLead
        ? 'Team Lead'
        : null;
  return roleLabel[user.role] + (title ? '  –  ' + title : '');
}

export function Login({ onLogin, initialError, options }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const passwordFocus = useRef(null);
  const [register, setRegister] = useState(false);
  const [notice, setNotice] = useState('');
  const samples = useJson(options.demo ? '/auth/samples' : null);
  const task = useTask();

  function signIn(event) {
    event.preventDefault();
    setNotice('');
    task.run(async () => onLogin(await post('/auth/login', { email, password })));
  }

  return (
    <main className="login">
      <LoginBrand />
      <section className="login-pane">
        <div className="login-form">
          <h1>Welcome back</h1>
          <p>Sign in to report, track and resolve IT incidents.</p>
          <form onSubmit={signIn}>
            <Field
              label={'E-mail (username@' + options.companyDomain + ')'}
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              ref={passwordFocus}
              maxLength={256}
              required
            />
            <ErrorText error={task.error || initialError} />
            {notice && (
              <p className="success" role="status">
                {notice}
              </p>
            )}
            <button type="submit" className="primary" disabled={task.pending}>
              {task.pending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          {options.registration && (
            <button type="button" className="ghost" onClick={() => setRegister(true)}>
              New here? Create an employee account
            </button>
          )}
          {samples.data?.length > 0 && (
            <section className="samples">
              <h2>SAMPLE ACCOUNTS (one per role)</h2>
              <p>Use these credentials to sign in above.</p>
              {samples.data.map((account) => (
                <article key={account.email} className="sample">
                  <Pill value={account.role} />
                  <div className="sample-values">
                    <div>
                      <small>E-mail</small>
                      <code>{account.email}</code>
                    </div>
                    <div>
                      <small>Password</small>
                      <code>{account.password || '(changed by the user)'}</code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(account.password || '');
                      passwordFocus.current?.focus();
                    }}
                  >
                    Fill form
                  </button>
                </article>
              ))}
            </section>
          )}
        </div>
      </section>
      {register && (
        <Modal
          title="Register as employee"
          onClose={() => setRegister(false)}
          submitLabel="Create account"
          onSubmit={async (data) => {
            const user = await post('/auth/register', data);
            setEmail(user.email);
            setPassword('');
            setNotice('Account created. Sign in with your new password.');
            task.setError(null);
          }}
        >
          <Field
            label="Full name"
            name="name"
            autoComplete="name"
            minLength={2}
            maxLength={60}
            required
          />
          <Field label="E-mail" name="email" autoComplete="username" maxLength={254} required />
          <Field
            label="Password (8+, letter & digit)"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            required
          />
          <Field label="Department" name="department" maxLength={120} />
          <Field label="Location" name="location" maxLength={120} />
        </Modal>
      )}
    </main>
  );
}

function RoleFacts({ user }) {
  const countPath =
    user.role === 'EMPLOYEE'
      ? '/incidents' + queryString({ reporter: user.id })
      : user.role === 'TECHNICIAN'
        ? '/workload'
        : '/admin/dashboard';
  const { data, error } = useJson(countPath);
  let rows;
  if (user.role === 'EMPLOYEE')
    rows = [
      ['Department', user.department || '–'],
      ['Location', user.location || '–'],
      ['Incidents reported', data?.summary.total],
      ['Currently open', data?.summary.open],
    ];
  else if (user.role === 'TECHNICIAN')
    rows = [
      [
        'Skills',
        <div className="row">
          {(data?.user.skills || user.skills).map((s) => (
            <Pill key={s} tone="blue">
              {s}
            </Pill>
          ))}
        </div>,
      ],
      ['Experience', (data?.user.experienceYears ?? user.experienceYears) + ' years'],
      ['Team lead', (data?.user.teamLead ?? user.teamLead) ? 'Yes' : 'No'],
      [
        'Availability',
        (data?.user.available ?? user.available) ? 'Available for new assignments' : 'Unavailable',
      ],
      ['Current workload', data ? data.active + ' of ' + data.user.maxConcurrent + ' incidents' : null],
      ['Resolved / closed', data?.resolved],
    ];
  else
    rows = [
      ['Title', user.title],
      ['Incidents in system', data?.total],
      ['Open incidents', data?.open],
      ['Critical (open P1)', data?.critical],
    ];
  return (
    <section className="card">
      <h2>{roleLabel[user.role]} details</h2>
      <Facts rows={rows} />
      <ErrorText error={error} />
    </section>
  );
}

export function Profile({ user, onUpdate, onBack }) {
  const task = useTask();
  const [message, setMessage] = useState('');
  function change(event) {
    event.preventDefault();
    const data = formData(event),
      form = event.currentTarget;
    setMessage('');
    task.run(async () => {
      if (data.password !== data.confirm) throw new Error('The new passwords do not match.');
      onUpdate(await patch('/auth/password', { current: data.current, password: data.password }));
      form.reset();
      setMessage('Password updated. Use it the next time you sign in.');
    });
  }
  return (
    <div className="stack">
      <div className="row between">
        <h1>My Profile</h1>
        <button className="secondary" onClick={onBack}>
          Back to dashboard
        </button>
      </div>
      <section className="card profile-identity">
        <Avatar name={user.name} size={72} />
        <div className="stack">
          <h2>{user.name}</h2>
          <p className="muted">{user.email}</p>
          <div className="row">
            <Pill tone="blue">{roleSummary(user)}</Pill>
            <Pill value={user.active ? 'Active account' : 'Inactive'} />
          </div>
        </div>
      </section>
      <div className="columns">
        <div className="stack">
          <section className="card">
            <h2>Account details</h2>
            <Facts
              rows={[
                ['Full name', user.name],
                ['E-mail', user.email],
                ['Role', roleSummary(user)],
                ['User ID', user.id],
                ['Account status', user.active ? 'Active' : 'Inactive'],
                ['Member since', when(user.createdAt, true)],
                [
                  'Password last changed',
                  user.passwordChangedAt
                    ? when(user.passwordChangedAt, true)
                    : 'Never (initial password)',
                ],
              ]}
            />
          </section>
          <RoleFacts user={user} />
        </div>
        <div className="stack">
          <section className="card">
            <h2>Change password</h2>
            <form className="stack" onSubmit={change}>
              <Field
                label="Current password"
                type="password"
                name="current"
                autoComplete="current-password"
                maxLength={256}
                required
              />
              <Field
                label="New password"
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={256}
                required
              />
              <Field
                label="Confirm new password"
                type="password"
                name="confirm"
                autoComplete="new-password"
                minLength={8}
                maxLength={256}
                required
              />
              <ErrorText error={task.error} />
              {message && (
                <p className="success" role="status">
                  {message}
                </p>
              )}
              <div>
                <button type="submit" disabled={task.pending}>
                  Update password
                </button>
              </div>
            </form>
          </section>
          <section className="card">
            <h2>Security tips</h2>
            <ul className="muted">
              <li>Use at least 8 characters with a letter and a digit.</li>
              <li>Use a unique password for this account.</li>
              <li>Use the new password the next time you sign in.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
