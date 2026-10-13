import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { useStudentWorkspaceProfile } from '../../hooks/useStudentWorkspaceProfile';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { ROLES } from '../../lib/constants';
import { getTutorBillingSummary } from '../../services/firestoreService';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';
import { StudentPaymentHistory } from '../../components/billing/StudentPaymentHistory';
import { initializeSubscriptionPayment, verifySubscriptionPayment } from '../../services/paymentsService';
import { refreshStudentSubscriptionState, setStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';

export const ProfileBillingPage = ({ role }) => {
  const { profile, logout, refreshViewedProfile, isParentWorkspace, toStudentPath } = useStudentWorkspaceProfile();
  const navigate = useNavigate();
  const location = useLocation();
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(role === ROLES.TUTOR);
  const [subscriptionStatus, setSubscriptionStatus] = useState('');
  const [isStartingSubscription, setIsStartingSubscription] = useState(false);
  const subscriptionState = useStudentSubscriptionState(role === ROLES.STUDENT ? profile : null);
  const verifiedReference = useRef('');

  const continueSubscription = async (selection) => {
    setSubscriptionStatus('');
    setIsStartingSubscription(true);
    let redirectingToPaystack = false;
    try {
      const result = await initializeSubscriptionPayment({
        studentId: profile.uid,
        ...selection,
        callbackUrl: `${window.location.origin}${location.pathname}`,
      });
      if (result.freeCheckout) {
        const refreshedProfile = await refreshViewedProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        const discount = result.discount;
        if (discount?.billingDuration === 'recurring' && discount?.percentOff === 100) {
          setSubscriptionStatus('Subscription activated. This permanent 100% code will continue the same plan as zero-cost renewal cycles.');
        } else if (discount?.billingDuration === 'fixed_months' && discount?.percentOff === 100) {
          setSubscriptionStatus(`Subscription activated. The 100% discount covers the first ${discount.discountDurationMonths} monthly billing periods; manual payment is needed after that period because no reusable card authorization was created.`);
        } else {
          setSubscriptionStatus('Subscription activated with the discount code. Automatic renewal requires a successful card payment and reusable authorization.');
        }
      } else if (result.free) {
        const refreshedProfile = await refreshViewedProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        setSubscriptionStatus('Free plan activated. Unlimited question papers are available.');
        navigate(toStudentPath('/student/papers'));
      } else if (result.scheduledChange) {
        const refreshedProfile = await refreshViewedProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        const discountNote = result.discount
          ? ` ${result.discount.percentOff}% discount (${result.discount.billingDuration === 'fixed_months' ? `first ${result.discount.discountDurationMonths} months` : result.discount.billingDuration === 'recurring' ? 'recurring' : 'first payment'}) is reserved for this change; the next payment is R${Number(result.discount.finalAmount).toLocaleString('en-ZA')}.`
          : '';
        setSubscriptionStatus(`${result.quote.planName} will start on ${new Date(result.effectiveAt).toLocaleDateString()}.${discountNote}${result.manualPaymentRequired ? ' Payment will be required then.' : ''}`);
      } else if (result.pendingChangeCancelled) {
        setSubscriptionStatus('Scheduled change cancelled. Your current plan will continue.');
      } else if (result.alreadyActive) {
        setSubscriptionStatus(result.renewalCancelled
          ? `${result.quote.planName} remains active until ${new Date(result.renewalDate).toLocaleDateString()}. Resume renewal in subscription management to keep it after that date.`
          : `${result.quote.planName} is already active.`);
      } else if (result.authorizationUrl) {
        redirectingToPaystack = true;
        window.location.assign(result.authorizationUrl);
      } else {
        throw new Error('Could not start subscription checkout.');
      }
    } catch (error) {
      setSubscriptionStatus(error?.message || 'Could not start subscription checkout.');
    } finally {
      if (!redirectingToPaystack) setIsStartingSubscription(false);
    }
  };

  useEffect(() => {
    if (!isParentWorkspace || role !== ROLES.STUDENT || !profile?.uid) return undefined;
    const params = new URLSearchParams(location.search);
    const reference = params.get('reference') || params.get('trxref') || '';
    const studentId = params.get('studentId') || profile.uid;
    if (!reference || studentId !== profile.uid || verifiedReference.current === reference) return undefined;
    verifiedReference.current = reference;
    let active = true;
    setSubscriptionStatus('Verifying the student’s payment…');
    verifySubscriptionPayment(reference, profile.uid).then(async (verification) => {
      if (!active) return;
      if (verification?.status !== 'success') throw new Error(`Payment verification returned status: ${verification?.status || 'unknown'}`);
      const updatedProfile = await refreshViewedProfile(profile.uid);
      await refreshStudentSubscriptionState(updatedProfile || profile);
      setSubscriptionStatus(verification.authorizationOnly
        ? `Payment verified and subscription activated. The R1 card authorization refund is ${verification.refundStatus || 'pending'}.`
        : 'Payment verified and subscription activated.');
      navigate(location.pathname, { replace: true });
    }).catch((error) => {
      if (active) setSubscriptionStatus(error?.message || 'Payment verification failed.');
    });
    return () => { active = false; };
  }, [isParentWorkspace, location.pathname, location.search, navigate, profile, refreshViewedProfile, role]);

  useEffect(() => {
    if (role === ROLES.TUTOR && profile?.uid) {
      setSummaryLoading(true);
      getTutorBillingSummary(profile.uid).then(setSummary).catch(() => {
        setSummary({ totalLessons: 0, studentsTutored: 0, subjectsTutored: [], recentLessons: [] });
      }).finally(() => setSummaryLoading(false));
    }
  }, [profile?.uid, role]);

  if (role === ROLES.STUDENT) {
    return (
      <AppShell title="Subscription" subtitle="Choose your plan and billing period." role={role} user={profile} onLogout={logout}>
        <div className="panel mb-5 p-4 text-sm">
          {!subscriptionState ? <p className="inline-flex items-center gap-2" role="status"><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" />Checking your current subscription…</p> : (
            <>
              <p>Current plan: <strong>{subscriptionState.subscriptionPlanName}</strong>{subscriptionState.paymentCompleted ? ` · ${subscriptionState.subscriptionSubjectCount} subjects` : ''}{subscriptionState.subscriptionRenewalDate ? ` · renews ${new Date(subscriptionState.subscriptionRenewalDate?.toDate?.() ?? subscriptionState.subscriptionRenewalDate).toLocaleDateString()}` : ''}</p>
              {subscriptionState.subscriptionPlanId === 'free' ? <p className="mt-2 text-amber-700">{subscriptionState.requiresSubscriptionSelection ? 'Your account is on Free until you choose a subscription and complete payment.' : 'Free includes Past Papers. Choose a paid subscription to unlock the Examifying Program.'} Question papers remain available.</p> : null}
            </>
          )}
        </div>
        {subscriptionState ? (
          <SubscriptionLifecyclePanel
            studentId={profile.uid}
            subscriptionState={subscriptionState}
            onStateChange={(nextState) => setStudentSubscriptionState(profile.uid, nextState)}
            isCheckoutSubmitting={isStartingSubscription}
            onContinuePayment={() => {
              const selection = subscriptionState.pendingPlan || subscriptionState;
              continueSubscription({
                planId: selection.planId || subscriptionState.subscriptionPlanId,
                billingPeriod: selection.billingPeriod || subscriptionState.subscriptionBillingPeriod || 'monthly',
                subjectCount: selection.subjectCount || subscriptionState.subscriptionSubjectCount || 1,
                discountCode: selection.discountCode || '',
              });
            }}
          />
        ) : null}
        {subscriptionState ? <SubscriptionPlanSelector
          mobileSwipe
          studentId={profile.uid}
          key={`${subscriptionState.pendingPlan?.planId || subscriptionState.subscriptionPlanId}-${subscriptionState.pendingPlan?.billingPeriod || subscriptionState.subscriptionBillingPeriod}-${subscriptionState.pendingPlan?.subjectCount || subscriptionState.subscriptionSubjectCount}-${subscriptionState.pendingPlan?.discountCode || ''}`}
          initialSelection={{
            planId: subscriptionState.pendingPlan?.planId || subscriptionState.subscriptionPlanId,
            billingPeriod: subscriptionState.pendingPlan?.billingPeriod || subscriptionState.subscriptionBillingPeriod,
            subjectCount: subscriptionState.pendingPlan?.subjectCount || subscriptionState.subscriptionSubjectCount || 1,
          }}
          onContinue={continueSubscription}
          isSubmitting={isStartingSubscription}
          submitLabel="Checkout"
          initialDiscountCode={new URLSearchParams(location.search).get('discountCode') || subscriptionState.pendingPlan?.discountCode || ''}
        /> : null}
        {subscriptionStatus ? <div role="status" className="panel mt-5 p-4 text-sm">{subscriptionStatus}</div> : null}
        {isParentWorkspace ? <div className="mt-5"><StudentPaymentHistory studentId={profile.uid} /></div> : null}
      </AppShell>
    );
  }

  if (role === ROLES.TUTOR) {
    return (
      <AppShell title="Tutor billing" subtitle="Review tutoring activity used for billing and reconciliation." role={role} user={profile} onLogout={logout}>
        <section className="grid gap-4 md:grid-cols-3">
          <div className="panel p-5"><p className="text-sm text-slate-500">Lessons tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.totalLessons ?? 0}</p></div>
          <div className="panel p-5"><p className="text-sm text-slate-500">Students tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.studentsTutored ?? 0}</p></div>
          <div className="panel p-5"><p className="text-sm text-slate-500">Subjects tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.subjectsTutored?.length ?? 0}</p></div>
        </section>
        <section className="panel p-5">
          <p className="text-sm font-semibold text-slate-950">Recent lessons</p>
          <div className="mt-4 space-y-3">
            {summaryLoading ? <LoadingState label="Loading recent lessons…" /> : null}
            {(summary?.recentLessons ?? []).map((lesson) => (
              <div key={lesson.id ?? `${lesson.studentId}-${lesson.topic}-${lesson.completedOn}`} className="rounded-2xl bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-900">{lesson.topic}</p>
                <p className="mt-1 text-slate-500">{lesson.subject} • {lesson.studentName ?? 'Student'} • {lesson.completedOn ?? 'No date'}</p>
              </div>
            ))}
            {!summaryLoading && summary && !summary.recentLessons?.length ? <p className="text-sm text-slate-500">No completed lessons have been recorded yet.</p> : null}
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell title="Billing" subtitle="Billing information for this account." role={role} user={profile} onLogout={logout}>
      <div className="panel p-5 text-sm text-slate-600">No billing workflow is configured for this role yet.</div>
    </AppShell>
  );
};
