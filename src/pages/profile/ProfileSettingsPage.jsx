import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { updateUserSettings } from '../../services/firestoreService';
import { cancelCurrentUserAccountDeletion, scheduleCurrentUserAccountDeletion } from '../../services/authService';

const formatDeletionDate = (value) => {
  const date = value?.toDate?.() ?? (value instanceof Date ? value : value ? new Date(value) : null);
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-ZA', { dateStyle: 'long', timeZone: 'Africa/Johannesburg' }).format(date)
    : 'the scheduled date';
};

const NOTIFICATION_TYPES = [
  {
    key: 'account_updates',
    title: 'Account and sign-in',
    description: 'Account creation and important account notices.',
    channels: { inApp: true, email: true },
  },
  {
    key: 'payment_updates',
    title: 'Payments and subscriptions',
    description: 'Payment started, pending, successful, failed, refunded, or requiring attention.',
    channels: { inApp: true, email: true },
  },
  {
    key: 'tutor_assignments',
    title: 'Tutor assignments',
    description: 'When a student or tutor assignment is created or changed.',
    channels: { inApp: true, email: true },
  },
  {
    key: 'exercise_generation',
    title: 'Exercise generation completed',
    description: 'When a new set of exercises has been generated successfully.',
    channels: { inApp: true, email: true },
  },
  {
    key: 'exercise_submissions',
    title: 'Exercise submissions',
    description: 'When submitted exercise work is ready for marking.',
    channels: { inApp: true, email: false },
  },
  {
    key: 'peer_marking',
    title: 'Peer marking',
    description: 'When a peer-marking assignment is completed.',
    channels: { inApp: true, email: false },
  },
  {
    key: 'tutor_reports',
    title: 'Tutor reports',
    description: 'When a tutor adds a report for a student.',
    channels: { inApp: true, email: false },
  },
  {
    key: 'lesson_updates',
    title: 'Lesson updates',
    description: 'When a lesson is completed.',
    channels: { inApp: true, email: false },
  },
  {
    key: 'discount_offers',
    title: 'Discount offers and product updates',
    description: 'Optional marketing email. This is off unless you opt in.',
    channels: { inApp: false, email: true },
    marketing: true,
  },
];

const LEARNING_TYPES = new Set(['exercise_generation', 'exercise_submissions', 'peer_marking', 'tutor_reports', 'lesson_updates']);

const buildNotificationPreferences = (profile) => Object.fromEntries(NOTIFICATION_TYPES.map((type) => {
  const saved = profile?.settings?.notificationPreferences?.[type.key] ?? {};
  const legacyEmail = profile?.settings?.emailUpdates;
  const legacyLearning = profile?.settings?.learningReminders;
  return [type.key, {
    inApp: type.channels.inApp
      && (typeof saved.inApp === 'boolean' ? saved.inApp : !(LEARNING_TYPES.has(type.key) && legacyLearning === false)),
    email: type.channels.email
      && (typeof saved.email === 'boolean'
        ? saved.email
        : type.marketing
          ? profile?.marketingEmailOptIn === true
          : typeof legacyEmail === 'boolean' ? legacyEmail : true),
  }];
}));

export const ProfileSettingsPage = ({ role }) => {
  const { profile, logout, refreshProfile } = useAuth();
  const { runOperation } = useOperationStatus();
  const [preferences, setPreferences] = useState(() => buildNotificationPreferences(profile));
  const canConfigureAiMarking = ['tutor', 'teacher'].includes(String(role ?? '').toLowerCase());
  const [aiMarkingEnabled, setAiMarkingEnabled] = useState(profile?.settings?.aiMarkingEnabled !== false);
  const [marketingEmailOptIn, setMarketingEmailOptIn] = useState(profile?.marketingEmailOptIn === true);
  const [status, setStatus] = useState('');
  const [deletionStatus, setDeletionStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setPreferences(buildNotificationPreferences(profile));
    setMarketingEmailOptIn(profile?.marketingEmailOptIn === true);
    setAiMarkingEnabled(profile?.settings?.aiMarkingEnabled !== false);
  }, [profile]);

  const handleToggle = (type, channel) => (event) => {
    const enabled = event.target.checked;
    setPreferences((current) => ({
      ...current,
      [type.key]: { ...current[type.key], [channel]: enabled },
    }));
    if (type.marketing && channel === 'email') setMarketingEmailOptIn(enabled);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setStatus('Saving settings…');
      await runOperation({ operationName: 'Saving settings', successMessage: 'Your settings are saved.' }, async () => {
        await updateUserSettings({
          uid: profile.uid,
          settings: { notificationPreferences: preferences, ...(canConfigureAiMarking ? { aiMarkingEnabled } : {}) },
          marketingEmailOptIn,
        });
        await refreshProfile(profile.uid);
      });
      setStatus('Settings saved.');
    } catch (error) {
      setStatus(error.message || 'Could not save notification settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    const typed = window.prompt('Type DELETE to schedule permanent account deletion after 30 days. You can cancel during that period.');
    if (typed !== 'DELETE') {
      setDeletionStatus('Account deletion request cancelled.');
      return;
    }

    try {
      setDeleting(true);
      setDeletionStatus('Scheduling account deletion…');
      const result = await runOperation({
        operationName: 'Scheduling account deletion',
        successMessage: 'Your account is scheduled for deletion in 30 days. You can cancel it in Settings before then.',
        autoDismissMs: 6000,
      }, scheduleCurrentUserAccountDeletion);
      await refreshProfile(profile.uid);
      setDeletionStatus(`Your account is scheduled for deletion on ${formatDeletionDate(result.scheduledFor)}. You can cancel it any time before then.`);
    } catch (error) {
      setDeletionStatus(error.message || 'Could not schedule account deletion.');
    } finally {
      setDeleting(false);
    }
  };

  const handleCancelAccountDeletion = async () => {
    if (!window.confirm('Cancel the scheduled deletion and keep your Examifying account?')) return;
    try {
      setDeleting(true);
      setDeletionStatus('Cancelling scheduled account deletion…');
      await runOperation({
        operationName: 'Cancelling account deletion',
        successMessage: 'Your account deletion request has been cancelled. Your account remains active.',
        autoDismissMs: 5000,
      }, cancelCurrentUserAccountDeletion);
      await refreshProfile(profile.uid);
      setDeletionStatus('Your account deletion request has been cancelled. Your account remains active.');
    } catch (error) {
      setDeletionStatus(error.message || 'Could not cancel account deletion.');
    } finally {
      setDeleting(false);
    }
  };

  const deletionScheduled = profile?.accountDeletionStatus === 'scheduled' && Boolean(profile?.accountDeletionScheduledFor);
  const deletionProcessing = profile?.accountDeletionStatus === 'deleting';

  return (
    <AppShell title="Settings" subtitle="Manage notifications and account preferences." role={role} user={profile} onLogout={logout}>
      <section className="panel max-w-4xl space-y-5 p-5 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lime-600">Preferences</p>
          <h2 className="mt-1 text-xl font-bold text-slate-950">Notifications</h2>
          <p className="mt-2 text-sm text-slate-600">Choose which Examifying notifications you receive in the app and by email.</p>
        </div>

        <div className="hidden grid-cols-[minmax(0,1fr)_90px_90px] gap-3 border-b border-slate-200 pb-2 text-center text-xs font-bold uppercase tracking-wide text-slate-500 sm:grid">
          <span className="text-left">Notification type</span><span>In-app</span><span>Email</span>
        </div>

        <div className="divide-y divide-slate-200">
          {NOTIFICATION_TYPES.map((type) => (
            <div key={type.key} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_90px_90px] sm:items-center">
              <div>
                <p className="font-semibold text-slate-950">{type.title}</p>
                <p className="mt-1 text-sm text-slate-600">{type.description}</p>
              </div>
              {['inApp', 'email'].map((channel) => (
                <label key={channel} className={`flex items-center justify-between gap-3 text-sm text-slate-700 sm:justify-center ${!type.channels[channel] ? 'opacity-55' : ''}`}>
                  <span className="sm:hidden">{channel === 'inApp' ? 'In-app notification' : 'Email notification'}</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-lime-500"
                    checked={type.marketing && channel === 'email'
                      ? marketingEmailOptIn
                      : Boolean(preferences[type.key]?.[channel])}
                    disabled={!type.channels[channel] || saving || deleting}
                    onChange={handleToggle(type, channel)}
                    aria-label={`${type.title}: ${channel === 'inApp' ? 'in-app' : 'email'}`}
                  />
                  {!type.channels[channel] ? <span className="sr-only">Unavailable</span> : null}
                </label>
              ))}
            </div>
          ))}
        </div>

        <p className="text-xs leading-5 text-slate-500">Account, payment, assignment, and successful exercise-generation emails are service notifications. Discount offers are optional marketing and are sent only when you opt in. Exercise submissions, peer marking, tutor reports, and lesson activity remain in-app only.</p>
        <div className="flex flex-wrap items-center gap-4">
          <button className="btn-primary" onClick={handleSave} disabled={saving || deleting}>{saving ? 'Saving…' : 'Save notification settings'}</button>
          {status ? <p role="status" className="text-sm text-slate-600">{status}</p> : null}
        </div>
      </section>

      {canConfigureAiMarking ? <section className="panel max-w-4xl space-y-4 p-5 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lime-600">Marking</p>
          <h2 className="mt-1 text-xl font-bold text-slate-950">AI-assisted marking</h2>
          <p className="mt-2 text-sm text-slate-600">When enabled, submitted student exercises and peer-marking work are assessed in the background. You can still review and change every mark manually.</p>
        </div>
        <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-lime-500"
            checked={aiMarkingEnabled}
            disabled={saving || deleting}
            onChange={(event) => setAiMarkingEnabled(event.target.checked)}
            aria-label="AI-assisted marking"
          />
          <span>
            <span className="block font-semibold text-slate-950">Enable AI-assisted marking</span>
            <span className="mt-1 block text-sm text-slate-600">This feature is available without billing restrictions. Existing tutors default to enabled unless they turn it off.</span>
          </span>
        </label>
      </section> : null}

      <section className="panel max-w-4xl space-y-4 border-rose-200 p-6">
        <div>
          <p className="font-semibold text-rose-700">{deletionProcessing ? 'Account deletion in progress' : deletionScheduled ? 'Account deletion scheduled' : 'Delete account'}</p>
          {deletionScheduled ? (
            <p role="status" className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              Your account is scheduled for permanent deletion on <strong>{formatDeletionDate(profile.accountDeletionScheduledFor)}</strong>.
              {' '}Your account remains available during the 30-day period. You can cancel the deletion below before that date.
            </p>
          ) : deletionProcessing ? (
            <p role="status" className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">The 30-day period has ended and permanent account deletion is being processed.</p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Scheduling deletion starts a 30-day period. Your account stays available during that time, and you can cancel the request from Settings. After the period ends, the account and its user data are permanently removed.</p>
          )}
        </div>
        <button
          type="button"
          onClick={deletionScheduled ? handleCancelAccountDeletion : handleDeleteAccount}
          disabled={deleting || deletionProcessing}
          className={deletionScheduled
            ? 'btn-secondary disabled:cursor-not-allowed disabled:opacity-60'
            : 'rounded-full bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60'}
        >
          {deleting ? 'Please wait…' : deletionProcessing ? 'Deletion in progress' : deletionScheduled ? 'Cancel scheduled deletion' : 'Schedule account deletion'}
        </button>
        {deletionStatus ? <p role="status" className="text-sm text-slate-600">{deletionStatus}</p> : null}
      </section>
    </AppShell>
  );
};
