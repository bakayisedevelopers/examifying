import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Logo } from '../../components/common/Logo';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { REGIONS, ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { normalizeWhatsAppNumber } from '../../utils/whatsapp';
import { getPortalForProfile } from '../../utils/portal';

export const GoogleAccountSetupPage = ({ role }) => {
  const { profile, completeAccountSetup } = useAuth();
  const navigate = useNavigate();
  const { runOperation } = useOperationStatus();
  const [form, setForm] = useState({
    displayName: profile?.displayName || '',
    grade: SOUTH_AFRICAN_GRADES[0],
    province: REGIONS[0],
    school: profile?.school || '',
    whatsappNumber: '',
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const isStudent = role === ROLES.STUDENT;
  const isTeacher = role === 'teacher';

  if (!profile?.uid) return <Navigate to="/login" replace />;
  if (profile.accountSetupStatus !== 'required') {
    const dashboard = isStudent ? '/student'
      : getPortalForProfile(profile) === 'teacher' ? '/teacher/onboarding' : '/tutor/onboarding';
    return <Navigate to={dashboard} replace />;
  }

  const handleChange = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatus('');
    try {
      const whatsappNumber = normalizeWhatsAppNumber(form.whatsappNumber);
      await runOperation({ operationName: 'Saving required account details', successMessage: 'Your account details were saved.', autoDismissMs: 650 }, () => completeAccountSetup({
        uid: profile.uid,
        displayName: form.displayName,
        ...(isStudent ? {
          grade: form.grade,
          province: form.province,
          school: form.school,
        } : {
          ...(isTeacher ? { school: form.school } : {}),
        }),
        whatsappNumber,
      }));
      navigate(isStudent ? '/student/billing?planId=free&billingPeriod=monthly&subjectCount=1'
        : isTeacher ? '/teacher/onboarding' : '/tutor/onboarding', { replace: true });
    } catch (error) {
      setStatus(error.message || 'Could not save your account details. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center justify-center px-4 py-12 lg:px-6">
      <form onSubmit={handleSubmit} className="panel grid w-full gap-5 border border-slate-800 bg-slate-900/90 p-6 shadow-2xl sm:p-8 md:grid-cols-2">
        <header className="md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">One more step</p>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">Finish setting up your {isStudent ? 'student' : isTeacher ? 'teacher' : 'tutor'} account</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">These details are required before you continue to {isStudent ? 'subscription and subject setup' : 'your subject and results setup'}.</p>
          <Logo className="mt-4" />
        </header>

        <label className="block md:col-span-2">
          <span className="label">Full name</span>
          <input className="input" autoComplete="name" value={form.displayName} onChange={handleChange('displayName')} required />
        </label>

        {isStudent ? <>
          <label className="block">
            <span className="label">Grade</span>
            <select className="input" value={form.grade} onChange={handleChange('grade')} required>
              {SOUTH_AFRICAN_GRADES.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">Province</span>
            <select className="input" value={form.province} onChange={handleChange('province')} required>
              {REGIONS.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="label">School name</span>
            <input className="input" autoComplete="organization" placeholder="e.g. Pretoria High School" value={form.school} onChange={handleChange('school')} required />
          </label>
          <label className="block md:col-span-2">
            <span className="label">WhatsApp number</span>
            <input type="tel" inputMode="tel" autoComplete="tel" className="input" placeholder="082 123 4567 or +27 82 123 4567" value={form.whatsappNumber} onChange={handleChange('whatsappNumber')} required />
            <span className="mt-1 block text-xs text-slate-400">Required for lesson coordination. South African numbers are saved with +27.</span>
          </label>
        </> : <>
          {isTeacher ? <label className="block md:col-span-2">
            <span className="label">School you teach at</span>
            <input className="input" autoComplete="organization" placeholder="e.g. Johannesburg Secondary School" value={form.school} onChange={handleChange('school')} required />
          </label> : null}
          <label className="block md:col-span-2">
            <span className="label">WhatsApp number</span>
            <input type="tel" inputMode="tel" autoComplete="tel" className="input" placeholder="+27 82 123 4567 or +44 20 1234 5678" value={form.whatsappNumber} onChange={handleChange('whatsappNumber')} required />
            <span className="mt-1 block text-xs text-slate-400">Include your country code. This is stored privately for assigned students.</span>
          </label>
        </>}

        {status ? <p className="text-sm text-rose-400 md:col-span-2" role="alert">{status}</p> : null}
        <button type="submit" className="btn-primary w-full md:col-span-2" disabled={saving}>
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </main>
  );
};
