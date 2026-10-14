import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { REGIONS, ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { Logo } from '../../components/common/Logo';
import { GoogleSignInButton } from '../../components/common/GoogleSignInButton';
import { normalizeWhatsAppNumber } from '../../utils/whatsapp';
import { LEGAL_POLICY_VERSION } from '../../lib/legalPolicyVersion';
import { getPortal, getPortalConfig, getPortalForProfile, getPortalSiteUrl, isProfileAllowedOnPortal } from '../../utils/portal';
import { saveParentFamilyCheckoutDraft } from '../../services/parentFamilyService';

export const SignupPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const portal = getPortal();
  const portalConfig = getPortalConfig(portal);
  const { register, registerWithGoogle, completeManagedStudentInvite, profile, loading, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [creating, setCreating] = useState(false);

  const initialRole = portalConfig.signupRole || ROLES.STUDENT;

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    role: initialRole,
    grade: SOUTH_AFRICAN_GRADES[0],
    province: REGIONS[0],
    school: '',
    whatsappNumber: '',
    marketingEmailOptIn: false,
  });

  const [status, setStatus] = useState('');
  const [accountPortal, setAccountPortal] = useState(null);
  const pendingDiscountCode = new URLSearchParams(location.search).get('discountCode')?.toUpperCase() || '';
  const selectionParams = new URLSearchParams(location.search);
  const familyDraftId = selectionParams.get('familyDraftId') || '';
  const managedStudentInvite = selectionParams.get('managedStudentInvite') || '';
  const familyHandoffStarted = useRef(false);
  const [familyHandoffStatus, setFamilyHandoffStatus] = useState('Preparing your saved family plan…');
  const [inviteForm, setInviteForm] = useState({ displayName: '', email: '', password: '', marketingEmailOptIn: false });

  useEffect(() => {
    if (profile?.role !== ROLES.PARENT || !familyDraftId || familyHandoffStarted.current) return;
    familyHandoffStarted.current = true;
    try {
      const rawDraft = window.localStorage.getItem('examifying-parent-family-draft');
      const saved = rawDraft ? JSON.parse(rawDraft) : null;
      if (!saved || saved.draftId !== familyDraftId || !Array.isArray(saved.slots)) {
        throw new Error('Your family plan details were not found in this browser. Return to the parent pricing page and build the plan again.');
      }
      void saveParentFamilyCheckoutDraft(saved).then(() => {
        window.localStorage.removeItem('examifying-parent-family-draft');
        navigate(`/parent/family-setup?draftId=${encodeURIComponent(familyDraftId)}`, { replace: true });
      }).catch((error) => {
        familyHandoffStarted.current = false;
        setFamilyHandoffStatus(error?.message || 'Could not save the family plan. Please try again.');
      });
    } catch (error) {
      familyHandoffStarted.current = false;
      setFamilyHandoffStatus(error?.message || 'Could not load the family plan.');
    }
  }, [familyDraftId, navigate, profile?.role]);

  if (portal === 'admin') return <Navigate to="/login" replace />;

  if (loading) {
    return <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-2xl items-center justify-center px-4 py-12 text-sm text-slate-300">Loading your account…</main>;
  }

  if (profile?.role && !managedStudentInvite) {
    if (profile.role === ROLES.PARENT && familyDraftId) {
      return <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-2xl items-center justify-center px-4 py-12"><div className="panel w-full p-8 text-center"><Logo className="mx-auto" /><h1 className="mt-5 text-xl font-bold text-white">Finishing family setup</h1><p className="mt-2 text-sm text-slate-300">{familyHandoffStatus}</p><Link className="mt-5 inline-flex text-sm font-semibold text-lime-300 underline" to="/parent">Return to Family Home</Link></div></main>;
    }
    if (profile.accountSetupStatus === 'required') {
      const setupPath = profile.role === ROLES.STUDENT ? '/student/account-setup'
        : getPortalForProfile(profile) === 'teacher' ? '/teacher/account-setup' : '/tutor/account-setup';
      return <Navigate to={setupPath} replace />;
    }
    const selection = new URLSearchParams(location.search);
    if (profile.role === ROLES.STUDENT) {
      if (profile.profileCompletionStatus === 'paid_incomplete') return <Navigate to="/student/onboarding" replace />;
      if (profile.profileCompletionStatus === 'paid_completed' && !selection.has('planId') && !selection.has('discountCode')) {
        return <Navigate to="/student" replace />;
      }
      if (!['free', 'circle', 'personalized'].includes(selection.get('planId'))) {
        selection.set('planId', ['circle', 'personalized'].includes(profile.subscriptionPlanId) ? profile.subscriptionPlanId : 'circle');
      }
      if (!selection.has('billingPeriod')) selection.set('billingPeriod', profile.subscriptionBillingPeriod || 'monthly');
      if (!selection.has('subjectCount')) selection.set('subjectCount', String(profile.subscriptionSubjectCount || 1));
      return <Navigate to={`/student/billing?${selection.toString()}`} replace />;
    }
    if (profile.role === ROLES.PARENT && pendingDiscountCode) {
      return <Navigate to={`/parent?discountCode=${encodeURIComponent(pendingDiscountCode)}`} replace />;
    }
    const profilePortal = getPortalForProfile(profile);
    if (['tutor', 'teacher'].includes(profile.role) && profile.profileCompletionStatus !== 'completed') {
      return <Navigate to={profilePortal === 'teacher' ? '/teacher/onboarding' : '/tutor/onboarding'} replace />;
    }
    return <Navigate to={profilePortal === 'teacher' ? '/teacher' : `/${profile.role}`} replace />;
  }

  if (pendingDiscountCode && !familyDraftId && !managedStudentInvite && new URLSearchParams(location.search).get('checkout') !== '1') {
    return <Navigate to={`/${location.search}`} replace />;
  }

  const handleChange = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();

    setCreating(true);
    if (form.role !== portalConfig.signupRole) {
      setStatus(`This site only creates ${portalConfig.label.toLowerCase()} accounts.`);
      setCreating(false);
      return;
    }
    let whatsappNumber = '';

    if (form.role === ROLES.STUDENT) {
      if (form.grade.trim() === 'Select Grade') {
        setStatus('Please select a valid grade.');
        setCreating(false);
        return;
      }
      if (form.province.trim() === 'Select Province' || form.province.trim() === 'National') {
        setStatus('Please select a valid province.');
        setCreating(false);
        return;
      }
      if (!form.school.trim()) {
        setStatus('Please enter your school name.');
        setCreating(false);
        return;
      }
      try {
        whatsappNumber = normalizeWhatsAppNumber(form.whatsappNumber);
      } catch (error) {
        setStatus(error.message);
        setCreating(false);
        return;
      }
    }

    if (form.role === ROLES.TUTOR || form.role === 'teacher') {
      try {
        whatsappNumber = normalizeWhatsAppNumber(form.whatsappNumber);
      } catch (error) {
        setStatus(error.message);
        setCreating(false);
        return;
      }
    }

    if (form.role === 'teacher') {
      if (!form.school.trim()) {
        setStatus('Please enter the school you are teaching in.');
        setCreating(false);
        return;
      }
    }

    try {
      const effectiveRole = form.role === 'teacher' ? ROLES.TUTOR : form.role;
      const result = await runOperation({ operationName: 'Creating your account', successMessage: 'Your account was created.', autoDismissMs: 650 }, () => register({
        fullName: form.fullName,
        email: form.email,
        password: form.password,
        role: effectiveRole,
        legalAcceptance: {
          termsAccepted: true,
          privacyNoticeAcknowledged: true,
          version: LEGAL_POLICY_VERSION,
        },
        extraProfile: {
          grade: form.role === ROLES.STUDENT ? form.grade : null,
          province: form.role === ROLES.STUDENT ? form.province : null,
          school: (form.role === ROLES.STUDENT || form.role === 'teacher') ? form.school.trim() : null,
          ...(form.role === ROLES.STUDENT ? { whatsappNumber } : {}),
          ...([ROLES.TUTOR, 'teacher'].includes(form.role) ? { whatsappNumber } : {}),
          isTeacher: form.role === 'teacher',
          marketingEmailOptIn: form.marketingEmailOptIn,
        },
      }));

      const targetRoute = form.role === 'teacher' ? '/teacher/onboarding'
        : form.role === ROLES.TUTOR ? '/tutor/onboarding' : `/${result.profile.role}`;
      const selection = new URLSearchParams(location.search);
      const planId = selection.get('planId');
      if (form.role === ROLES.STUDENT) {
        const selectedPlanId = ['free', 'circle', 'personalized'].includes(planId)
          ? planId
          : selection.has('discountCode') ? 'circle' : 'free';
        const billingPeriod = selection.get('billingPeriod') === 'yearly' ? 'yearly' : 'monthly';
        const subjectCount = selection.get('subjectCount') || '1';
        const discountCode = selection.get('discountCode');
        const billingParams = new URLSearchParams({ planId: selectedPlanId, billingPeriod, subjectCount });
        if (discountCode) billingParams.set('discountCode', discountCode.toUpperCase());
        navigate(`/student/billing?${billingParams.toString()}`);
      } else if (form.role === ROLES.PARENT && familyDraftId) {
        setFamilyHandoffStatus('Account created. Saving the family plan…');
      } else if (form.role === ROLES.PARENT && selection.get('discountCode')) {
        navigate(`/parent?discountCode=${encodeURIComponent(selection.get('discountCode').toUpperCase())}`);
      } else {
        navigate(targetRoute);
      }
    } catch (error) {
      setStatus(error.message || 'Registration failed');
    } finally {
      setCreating(false);
    }
  };

  const handleGoogleSignUp = async () => {
    setCreating(true);
    setStatus('');
    setAccountPortal(null);
    try {
      if (form.role !== portalConfig.signupRole) throw new Error(`This site only creates ${portalConfig.label.toLowerCase()} accounts.`);
      const result = await runOperation({ operationName: 'Creating your account with Google', successMessage: 'Your account was created.', autoDismissMs: 650 }, () => registerWithGoogle({
        role: form.role,
        marketingEmailOptIn: form.marketingEmailOptIn,
      }));
      if (!isProfileAllowedOnPortal(result.profile, portal)) {
        const correctPortal = getPortalForProfile(result.profile);
        await logout();
        setAccountPortal(correctPortal);
        setStatus(`This Google account already belongs to the ${getPortalConfig(correctPortal).label.toLowerCase()} site.`);
        return;
      }
      const createdProfile = result.profile;
      if (createdProfile.accountSetupStatus === 'required') {
        navigate(createdProfile.role === ROLES.STUDENT ? '/student/account-setup'
          : getPortalForProfile(createdProfile) === 'teacher' ? '/teacher/account-setup' : '/tutor/account-setup');
      } else if (createdProfile.role === ROLES.STUDENT) {
        const selection = new URLSearchParams(location.search);
        if (!selection.has('planId')) selection.set('planId', selection.has('discountCode') ? 'circle' : 'free');
        if (!selection.has('billingPeriod')) selection.set('billingPeriod', 'monthly');
        if (!selection.has('subjectCount')) selection.set('subjectCount', '1');
        navigate(`/student/billing?${selection.toString()}`);
      } else if (['tutor', 'teacher'].includes(createdProfile.role)) {
        navigate(getPortalForProfile(createdProfile) === 'teacher' ? '/teacher/onboarding' : '/tutor/onboarding');
      } else if (familyDraftId && createdProfile.role === ROLES.PARENT) {
        setFamilyHandoffStatus('Account created. Saving the family plan…');
      } else {
        navigate('/parent');
      }
    } catch (error) {
      setStatus(error.message || 'Google sign up failed.');
    } finally {
      setCreating(false);
    }
  };

  const handleManagedStudentInvite = async (event) => {
    event.preventDefault();
    setCreating(true);
    setStatus('');
    try {
      const result = await completeManagedStudentInvite({ token: managedStudentInvite, ...inviteForm });
      if (result.profile.accountSetupStatus === 'required') {
        navigate('/student/account-setup', { replace: true });
      } else if (result.profile.profileCompletionStatus === 'paid_incomplete') {
        navigate('/student/onboarding', { replace: true });
      } else if (result.profile.profileCompletionStatus === 'paid_completed') {
        navigate('/student', { replace: true });
      } else {
        const studentSelection = new URLSearchParams({
          planId: ['circle', 'personalized'].includes(result.profile.subscriptionPlanId) ? result.profile.subscriptionPlanId : 'circle',
          billingPeriod: result.profile.subscriptionBillingPeriod || 'monthly',
          subjectCount: String(result.profile.subscriptionSubjectCount || 1),
        });
        navigate(`/student/billing?${studentSelection.toString()}`, { replace: true });
      }
    } catch (error) {
      setStatus(error?.message || 'Could not finish setting up the student account.');
    } finally {
      setCreating(false);
    }
  };

  if (managedStudentInvite) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-2xl items-center justify-center px-4 py-12 lg:px-6">
        <form onSubmit={handleManagedStudentInvite} className="panel w-full space-y-5 border border-slate-800 bg-slate-900/90 p-8 shadow-2xl">
          <div><p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Student account setup</p><h1 className="mt-2 text-2xl font-bold text-white">Create your sign-in</h1><p className="mt-2 text-sm leading-6 text-slate-300">Your parent has already created and linked your Examifying student profile. Use your own email or the placeholder address they provided; this setup connects the sign-in to that same profile.</p><Logo className="mt-4" /></div>
          <label className="block"><span className="label">Student’s full name</span><input className="input w-full" value={inviteForm.displayName} onChange={(event) => setInviteForm((current) => ({ ...current, displayName: event.target.value }))} required maxLength={100} /></label>
          <label className="block"><span className="label">Email address</span><input type="email" className="input w-full" value={inviteForm.email} onChange={(event) => setInviteForm((current) => ({ ...current, email: event.target.value }))} required autoComplete="email" /></label>
          <label className="block"><span className="label">Password</span><input type="password" className="input w-full" value={inviteForm.password} onChange={(event) => setInviteForm((current) => ({ ...current, password: event.target.value }))} required minLength={8} autoComplete="new-password" /></label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-700 bg-slate-950/40 p-4 text-sm text-slate-300"><input type="checkbox" checked={inviteForm.marketingEmailOptIn} onChange={(event) => setInviteForm((current) => ({ ...current, marketingEmailOptIn: event.target.checked }))} className="mt-1 accent-lime-400" /><span>Email me occasional discount offers and product updates. This is optional and off by default.</span></label>
          <p className="text-xs leading-5 text-slate-400">Creating an account means you accept the <Link to="/policies#terms" className="font-semibold text-lime-300 underline">Terms of Use</Link> and acknowledge the <Link to="/policies#privacy" className="font-semibold text-lime-300 underline">Privacy Policy</Link>. If you are under 18, your parent or guardian must have provided the required consent.</p>
          {status ? <p role="alert" className="text-sm text-rose-300">{status}</p> : null}
          <button type="submit" className="btn-primary w-full" disabled={creating || !inviteForm.displayName.trim() || !inviteForm.email.trim() || inviteForm.password.length < 8}>{creating ? 'Creating your sign-in…' : 'Create student account'}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-2xl items-center justify-center px-4 py-12 lg:px-6">
      <form onSubmit={handleSubmit} className="panel w-full grid gap-5 p-8 md:grid-cols-2 border border-slate-800 bg-slate-900/90 shadow-2xl">
        <div className="md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">
            Signup
          </p>
          <h2 className="mt-2 text-2xl sm:text-3xl font-bold text-white">
            Create your account
          </h2>
          <Logo className="mt-4" />
          {pendingDiscountCode ? <p className="mt-4 rounded-xl border border-lime-400/20 bg-lime-400/5 p-3 text-sm text-lime-200">Discount code <span className="font-mono font-bold">{pendingDiscountCode}</span> will be checked securely in checkout after account creation.</p> : null}
        </div>

        <div className="md:col-span-2 space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-700 bg-slate-950/40 p-4 text-xs text-slate-300 sm:text-sm">
            <input
              type="checkbox"
              checked={form.marketingEmailOptIn}
              onChange={(event) => setForm((current) => ({ ...current, marketingEmailOptIn: event.target.checked }))}
              className="mt-1 accent-lime-400"
            />
            <span>Email me occasional discount offers and product updates. This is optional and off by default; your choice is saved when you sign up and can be changed later in Settings. Essential account and payment emails are separate.</span>
          </label>
          <p className="text-xs leading-5 text-slate-400">
            By creating an account with email or Google, you agree to Examifying{' '}
            <Link to="/policies#terms" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">Terms of Use</Link>,{' '}
            <Link to="/policies#refunds" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">Refund Policy</Link>, and acknowledge our{' '}
            <Link to="/policies#privacy" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">Privacy Policy</Link>.
          </p>
          {form.role === ROLES.STUDENT ? <p className="text-xs leading-5 text-slate-400">If you are under 18, your parent, legal guardian, or another competent person must have given the consent or other lawful basis required to process your information before you create an account.</p> : null}
          <GoogleSignInButton onClick={handleGoogleSignUp} disabled={creating}>{creating ? 'Please wait…' : 'Sign up with Google'}</GoogleSignInButton>
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-slate-500"><span className="h-px flex-1 bg-slate-700" /><span>or use email</span><span className="h-px flex-1 bg-slate-700" /></div>
        </div>

        <label className="block">
          <span className="label">Full name</span>
          <input className="input" value={form.fullName} onChange={handleChange('fullName')} required />
        </label>

        <label className="block">
          <span className="label">Email</span>
          <input type="email" className="input" value={form.email} onChange={handleChange('email')} required />
        </label>

        <label className="block">
          <span className="label">Password</span>
          <input type="password" className="input" value={form.password} onChange={handleChange('password')} required minLength={6} />
        </label>

        <div className="rounded-xl border border-lime-400/20 bg-lime-400/5 p-4 text-sm text-lime-100">
          <span className="block text-xs font-semibold uppercase tracking-wide text-lime-300">Account type</span>
          <span className="mt-1 block font-semibold">{portalConfig.label} account</span>
        </div>

        {form.role === ROLES.STUDENT ? (
          <>
            <label className="block">
              <span className="label">School name</span>
              <input className="input" placeholder="e.g. Pretoria High School" value={form.school} onChange={handleChange('school')} required />
            </label>

            <label className="block">
              <span className="label">WhatsApp number</span>
              <input type="tel" inputMode="tel" autoComplete="tel" className="input" placeholder="082 123 4567 or +27 82 123 4567" value={form.whatsappNumber} onChange={handleChange('whatsappNumber')} required />
              <span className="mt-1 block text-xs text-slate-400">Required for lesson coordination. A South African number is saved with +27.</span>
            </label>

            <label className="block">
              <span className="label">Grade</span>
              <select className="input" value={form.grade} onChange={handleChange('grade')}>
                {SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="label">Province</span>
              <select className="input" value={form.province} onChange={handleChange('province')}>
                {REGIONS.map((region) => <option key={region}>{region}</option>)}
              </select>
            </label>

          </>
        ) : null}

        {form.role === 'teacher' ? (
          <>
            <label className="block">
              <span className="label">WhatsApp number</span>
              <input type="tel" inputMode="tel" autoComplete="tel" className="input" placeholder="+27 82 123 4567 or +44 20 1234 5678" value={form.whatsappNumber} onChange={handleChange('whatsappNumber')} required />
              <span className="mt-1 block text-xs text-slate-400">Include your country code. This is saved privately for assigned students.</span>
            </label>
            <label className="block">
              <span className="label">School teaching in</span>
              <input className="input" placeholder="e.g. Johannesburg Secondary School" value={form.school} onChange={handleChange('school')} required />
            </label>
          </>
        ) : null}

        {form.role === ROLES.TUTOR ? (
          <label className="block md:col-span-2">
            <span className="label">WhatsApp number</span>
            <input type="tel" inputMode="tel" autoComplete="tel" className="input" placeholder="+27 82 123 4567 or +44 20 1234 5678" value={form.whatsappNumber} onChange={handleChange('whatsappNumber')} required />
            <span className="mt-1 block text-xs text-slate-400">Include your country code. This is saved privately for assigned students.</span>
          </label>
        ) : null}

        <div className="md:col-span-2">
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={(form.fullName.trim() === '' || form.email.trim() === '' || form.password.trim() === '' || (form.role === ROLES.STUDENT && (form.grade.trim() === 'Select Grade' || form.province.trim() === 'National' || !form.school.trim() || !form.whatsappNumber.trim())) || ([ROLES.TUTOR, 'teacher'].includes(form.role) && !form.whatsappNumber.trim()) || (form.role === 'teacher' && !form.school.trim())) || creating}
          >
            {creating ? 'Creating account...' : 'Create account'}
          </button>

          {status ? <p className="mt-3 text-sm text-rose-500">{status}</p> : null}
          {accountPortal ? <a href={getPortalSiteUrl(accountPortal)} className="mt-3 block text-center text-sm font-semibold text-lime-400 hover:text-lime-300 hover:underline">Go to the {getPortalConfig(accountPortal).label.toLowerCase()} site</a> : null}

          <p className="mt-4 text-sm text-slate-400 text-center">
            Already have an account?{' '}
            <Link to={`/login${location.search}`} className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Log in
            </Link>.
          </p>
        </div>
      </form>
    </main>
  );
};
