import { useCallback, useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { AuthorizationChargeDisclosure } from '../../components/billing/AuthorizationChargeDisclosure';
import { 
  assignStudentToParent, 
  getStudentsForParent, 
  getParentStudentSummary,
  createManagedStudentProfileForParent,
  updateStudentProfileByParent 
} from '../../services/firestoreService';
import { cancelSubscriptionPaymentCheckout, initializeSubscriptionPayment, verifySubscriptionPayment } from '../../services/paymentsService';
import { Users, Link as LinkIcon, AlertCircle, Edit, Check, X, Calendar, Activity, Plus } from 'lucide-react';
import { REGIONS, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';

const PARENT_GROUP_CHECKOUT_STORAGE_KEY = 'examifying-parent-group-checkout';

const EditDetailsForm = ({ student, onSave, onCancel }) => {
  const [form, setForm] = useState({
    displayName: student.displayName || '',
    previousYearMark: student.previousYearMark || 0,
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-slate-900/90 border border-slate-700 rounded-xl space-y-4 shadow-sm mb-4">
      <div className="flex justify-between items-center bg-lime-400/10 -mx-4 -mt-4 p-4 rounded-t-xl mb-2 border-b border-lime-400/20">
        <h4 className="font-semibold text-white">Edit Details</h4>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-200"><X className="w-5 h-5"/></button>
      </div>
      <div>
        <label className="label">Name</label>
        <input 
          type="text" 
          className="input w-full" 
          value={form.displayName}
          onChange={(e) => setForm({...form, displayName: e.target.value})}
          required
        />
      </div>
      <div>
        <label className="label">Start/Prev Mark (%)</label>
        <input 
          type="number" 
          className="input w-full" 
          value={form.previousYearMark}
          onChange={(e) => setForm({...form, previousYearMark: e.target.value})}
          required
        />
      </div>
      <button type="submit" className="btn-primary w-full flex justify-center items-center gap-2">
        <Check className="w-4 h-4"/> Save Details
      </button>
    </form>
  );
};

export const ParentDashboardPage = () => {
  const { profile, logout } = useAuth();
  const { runOperation, closeOperationStatus } = useOperationStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const [students, setStudents] = useState([]);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  const [studentIdInput, setStudentIdInput] = useState('');
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentGrade, setNewStudentGrade] = useState('Grade 10');
  const [newStudentProvince, setNewStudentProvince] = useState('');
  const [newStudentSchool, setNewStudentSchool] = useState('');
  const [newStudentWhatsApp, setNewStudentWhatsApp] = useState('');
  const [newStudentEmail, setNewStudentEmail] = useState('');
  const [autoGenerateEmail, setAutoGenerateEmail] = useState(true);
  const [groupStudentIds, setGroupStudentIds] = useState([]);
  const [groupSelections, setGroupSelections] = useState({});
  const [groupCheckoutOpen, setGroupCheckoutOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [editingStudentId, setEditingStudentId] = useState(null);
  const [subscriptionStudent, setSubscriptionStudent] = useState(null);
  const [pendingAuthorizationCheckout, setPendingAuthorizationCheckout] = useState(null);
  const [pendingCheckout, setPendingCheckout] = useState(null);
  const [isCancellingAuthorizationCheckout, setIsCancellingAuthorizationCheckout] = useState(false);
  
  const lastVerifiedReferenceRef = useRef(null);
  const handledDiscountLinkRef = useRef('');

  useScreenLoadMetrics('Parent dashboard', 'parent', studentsLoaded);

  const loadStudents = useCallback(async () => {
    if (!profile?.uid) return [];
    let parentStudents;
    try {
      parentStudents = await getStudentsForParent(profile.uid);
    } catch (loadError) {
      setStatus(loadError?.message || 'Could not load linked students. Please try again.');
      setStudentsLoaded(true);
      return [];
    }

    const fallbackStudents = parentStudents.map((student) => ({
      ...student,
      summaryUnavailable: true,
      completedLessonsCount: Number(student.completedLessonsCount || 0),
      todayExercise: null,
      paymentCompleted: student.paymentCompleted === true,
      subscriptionPlanId: student.subscriptionPlanId || 'free',
      subscriptionPlanName: student.subscriptionPlanName || 'Free',
      subscriptionStatus: student.subscriptionStatus || 'pending',
      subscriptionBillingPeriod: student.subscriptionBillingPeriod || null,
      subscriptionSubjectCount: Number(student.subscriptionSubjectCount || 0),
      subscriptionRenewalDate: student.subscriptionRenewalDate || null,
      requiresSubscriptionSelection: student.requiresSubscriptionSelection ?? student.paymentCompleted !== true,
      autoRenew: student.autoRenew === true,
      cancelAtPeriodEnd: student.cancelAtPeriodEnd === true,
      pendingPlan: student.pendingPlan || null,
      pendingPlanReference: student.pendingPlanReference || null,
      graceEndsAt: student.graceEndsAt || null,
      renewalAttemptCount: Number(student.renewalAttemptCount || 0),
      nextRenewalAttemptAt: student.nextRenewalAttemptAt || null,
      manualPaymentRequired: student.manualPaymentRequired === true,
      lastChargeStatus: student.lastChargeStatus || null,
    }));
    setStudents(fallbackStudents);
    setStudentsLoaded(true);

    const enrichedStudents = await Promise.all(parentStudents.map(async (student, index) => {
      try {
        const accessState = await getParentStudentSummary(student);
        return {
          ...fallbackStudents[index],
          ...accessState,
          summaryUnavailable: false,
        };
      } catch {
        return fallbackStudents[index];
      }
    }));
    setStudents(enrichedStudents);
    return enrichedStudents;
  }, [profile?.uid]);

  const updateGroupSelection = useCallback((selection) => {
    const { studentId, ...choice } = selection ?? {};
    if (!studentId) return;
    setGroupSelections((current) => {
      const previous = current[studentId];
      if (previous && previous.planId === choice.planId && previous.billingPeriod === choice.billingPeriod
        && previous.subjectCount === choice.subjectCount && previous.discountCode === choice.discountCode) return current;
      return { ...current, [studentId]: choice };
    });
  }, []);

  const startGroupCheckout = useCallback(async (entries) => {
    if (!profile?.uid || !entries.length) return;
    let remaining = [...entries];
    setLoading(true);
    setStatus('Preparing subscriptions for the selected kids…');
    try {
      while (remaining.length) {
        window.sessionStorage.setItem(PARENT_GROUP_CHECKOUT_STORAGE_KEY, JSON.stringify(remaining));
        const [entry, ...rest] = remaining;
        const result = await initializeSubscriptionPayment({
          studentId: entry.studentId,
          ...entry.selection,
          callbackUrl: `${window.location.origin}${location.pathname}?groupCheckout=1`,
        });
        if (result.authorizationUrl) {
          setStatus(`Opening Paystack for ${entry.displayName || 'the selected student'}…`);
          window.location.assign(result.authorizationUrl);
          return;
        }
        if (result.freeCheckout || result.free || result.scheduledChange || result.pendingChangeCancelled || result.alreadyActive) {
          await loadStudents();
          remaining = rest;
          continue;
        }
        throw new Error(`Could not prepare a subscription for ${entry.displayName || 'the selected student'}.`);
      }
      window.sessionStorage.removeItem(PARENT_GROUP_CHECKOUT_STORAGE_KEY);
      setGroupCheckoutOpen(false);
      setGroupStudentIds([]);
      setGroupSelections({});
      setStatus('The selected kids’ subscription actions are complete. Each student’s payment and card authorization remain on that student’s record.');
      await loadStudents();
    } catch (error) {
      setStatus(error?.message || 'The group checkout could not be started.');
    } finally {
      setLoading(false);
    }
  }, [loadStudents, location.pathname, profile?.uid]);

  useEffect(() => {
    if (!profile?.uid) return;
    setStudentsLoaded(false);
    void loadStudents();
  }, [loadStudents, profile?.uid]);

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('discountCode')?.trim().toUpperCase() || '';
    if (!code || !students.length || handledDiscountLinkRef.current === code) return;
    handledDiscountLinkRef.current = code;
    if (students.length === 1) {
      setSubscriptionStudent(students[0]);
    } else {
      setStatus(`Discount code ${code} is ready. Choose a student’s subscription below to apply it.`);
    }
  }, [location.search, students]);

  useEffect(() => {
    const runVerification = async () => {
      if (!profile?.uid) return;

      const params = new URLSearchParams(location.search);
      const reference = params.get('reference') || params.get('trxref');
      const paymentStudentId = params.get('studentId');

      if (!reference || !paymentStudentId) return;
      if (lastVerifiedReferenceRef.current === reference) return;

      try {
        lastVerifiedReferenceRef.current = reference;
        setLoading(true);
        setStatus('Verifying your payment...');

        const verification = await runOperation({ operationName: 'Verifying student payment', successMessage: 'Payment verification finished.', autoDismissMs: 1200 }, () => verifySubscriptionPayment(reference, paymentStudentId));

        if (verification?.status !== 'success') {
          setStatus(`Payment verification returned status: ${verification?.status ?? 'unknown'}`);
          return;
        }

        const updatedStudents = await loadStudents();
        const updatedStudent = updatedStudents.find((student) => student.uid === paymentStudentId);
        if (!updatedStudent?.paymentCompleted) {
          throw new Error(`Paystack verified payment ${reference}, but subscription activation is still being finalized. Retry verification; do not pay again.`);
        }
        const authorizationNote = verification.authorizationOnly
          ? ` R1.00 was temporarily charged for card authorization; the automatic refund request is ${verification.refundStatus || 'pending'}${verification.nextBillingDate ? `. The next actual charge is expected ${new Date(verification.nextBillingDate).toLocaleDateString()} for R${Number(verification.nextBillingAmount || 0).toFixed(2)}` : (verification.noNextChargeWhileOfferApplies ? '. This offer has no paid renewal while it remains active' : '')}.${verification.manualPaymentRequired ? ' Paystack did not provide a reusable authorization, so the next payment will need to be completed manually.' : ''}`
          : '';
        if (params.get('groupCheckout') === '1') {
          let queue = [];
          try {
            queue = JSON.parse(window.sessionStorage.getItem(PARENT_GROUP_CHECKOUT_STORAGE_KEY) || '[]');
          } catch {
            queue = [];
          }
          const remaining = queue[0]?.studentId === paymentStudentId
            ? queue.slice(1)
            : queue.filter((entry) => entry.studentId !== paymentStudentId);
          if (remaining.length) {
            window.sessionStorage.setItem(PARENT_GROUP_CHECKOUT_STORAGE_KEY, JSON.stringify(remaining));
            setStatus(`Payment verified for ${updatedStudent.displayName || 'the student'}. Continuing with ${remaining.length} more student subscription${remaining.length === 1 ? '' : 's'}…`);
            setGroupCheckoutOpen(false);
            await startGroupCheckout(remaining);
            return;
          }
          window.sessionStorage.removeItem(PARENT_GROUP_CHECKOUT_STORAGE_KEY);
          setStatus(`All selected student subscriptions were processed.${authorizationNote}`);
          setGroupStudentIds([]);
          setGroupSelections({});
        } else {
          setStatus(`Payment verified and subscription activated.${authorizationNote}`);
        }
        navigate(location.pathname, { replace: true });
      } catch (error) {
        setStatus(error?.message || 'Payment verification failed.');
      } finally {
        setLoading(false);
      }
    };

    runVerification();
  }, [loadStudents, location.pathname, location.search, navigate, profile?.uid, runOperation, startGroupCheckout]);

  const handleLinkStudent = async (e) => {
    e.preventDefault();
    if (!studentIdInput.trim()) return;
    
    setLoading(true);
    setStatus('');
    try {
      await runOperation({ operationName: 'Linking student account', successMessage: 'The student account was linked.' }, async () => {
        await assignStudentToParent({ parentId: profile.uid, studentIdentifier: studentIdInput.trim() });
        await loadStudents();
      });
      setStatus('Student successfully linked!');
      setStudentIdInput('');
    } catch (err) {
      setStatus(err.message || 'Failed to link student.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateStudent = async (e) => {
    e.preventDefault();
    setLoading(true);
    setStatus('');
    try {
      await runOperation({ operationName: 'Creating managed student profile', successMessage: 'Student profile created.' }, async () => {
        await createManagedStudentProfileForParent({
          parentId: profile.uid,
          displayName: newStudentName,
          grade: newStudentGrade,
          province: newStudentProvince,
          school: newStudentSchool,
          whatsappNumber: newStudentWhatsApp,
          email: newStudentEmail,
          autoGenerateEmail,
        });
        await loadStudents();
      });
      setNewStudentName('');
      setNewStudentEmail('');
      setNewStudentProvince('');
      setNewStudentSchool('');
      setNewStudentWhatsApp('');
      setStatus('Student profile created and linked. This profile has no separate sign-in account yet.');
    } catch (err) {
      setStatus(err.message || 'Could not create the student profile.');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveDetails = async (studentId, form) => {
    try {
      setLoading(true);
      await runOperation({ operationName: 'Updating student details', successMessage: 'The student details were saved.' }, async () => {
        await updateStudentProfileByParent({ parentId: profile.uid, studentId, updates: form });
        await loadStudents();
      });
      setEditingStudentId(null);
      setStatus('Student details updated.');
    } catch (err) {
      setStatus(err.message || 'Failed to update details');
    } finally {
      setLoading(false);
    }
  };

  const handlePayForStudent = async (student, selection) => {
    try {
      setLoading(true);
      const result = await runOperation({ operationName: 'Starting student subscription checkout', successMessage: 'The subscription request is ready.' }, () => initializeSubscriptionPayment({
        studentId: student.uid,
        ...selection,
        callbackUrl: `${window.location.origin}${location.pathname}`,
      }));

      if (result.freeCheckout) {
        const renewalNote = result.discount?.billingDuration === 'recurring' && result.discount?.percentOff === 100
          ? ' This permanent 100% code will continue the same plan as zero-cost renewal cycles.'
          : result.discount?.billingDuration === 'fixed_months' && result.discount?.percentOff === 100
            ? ` The 100% discount covers the first ${result.discount.discountDurationMonths} monthly billing periods; manual payment is needed after that period because no reusable card authorization was created.`
            : ' Automatic renewal requires a successful card payment and reusable authorization.';
        setStatus(`${student.displayName || 'Student'} subscription activated with the discount code.${renewalNote}`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.free) {
        setStatus(`${student.displayName || 'Student'} is now on the Free plan.`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.scheduledChange) {
        const discountNote = result.discount
          ? ` A ${result.discount.percentOff}% discount (${result.discount.billingDuration === 'fixed_months' ? `first ${result.discount.discountDurationMonths} months` : result.discount.billingDuration === 'recurring' ? 'recurring' : 'first payment'}) is reserved for this change; the next payment is R${Number(result.discount.finalAmount).toLocaleString('en-ZA')}.`
          : '';
        setStatus(`${result.quote.planName} will start for ${student.displayName || 'the student'} on ${new Date(result.effectiveAt).toLocaleDateString()}.${discountNote}${result.manualPaymentRequired ? ' Payment will be required then.' : ''}`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.pendingChangeCancelled) {
        setStatus(`The scheduled change for ${student.displayName || 'the student'} was cancelled.`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.alreadyActive) {
        setStatus(result.renewalCancelled
          ? `${result.quote.planName} is active until ${new Date(result.renewalDate).toLocaleDateString()}; automatic renewal is cancelled.`
          : `${result.quote.planName} is already active for ${student.displayName || 'the student'}.`);
        setSubscriptionStudent(null);
      } else if (result.requiresAuthorizationDisclosure && result.authorizationUrl) {
        setPendingAuthorizationCheckout({ ...result, studentId: student.uid });
      } else if (!result?.authorizationUrl) {
        throw new Error('No Paystack authorization URL was returned.');
      } else {
        window.location.href = result.authorizationUrl;
      }
    } catch (error) {
      const pendingReference = error?.details?.pendingReference;
      if (pendingReference) {
        closeOperationStatus();
        setPendingCheckout({ reference: pendingReference, studentId: error.details.studentId || student.uid });
      }
      setStatus(error?.message || 'Unable to start subscription checkout.');
    } finally {
      setLoading(false);
    }
  };

  const checkPendingCheckout = async () => {
    if (!pendingCheckout?.reference || !pendingCheckout?.studentId) return;
    setLoading(true);
    try {
      const verification = await runOperation({
        operationName: 'Checking existing payment status',
        successMessage: 'Payment status check finished.',
        autoDismissMs: 1200,
      }, () => verifySubscriptionPayment(pendingCheckout.reference, pendingCheckout.studentId));
      const paymentStatus = String(verification?.status || 'unknown').toLowerCase();
      if (paymentStatus === 'success') {
        const updatedStudents = await loadStudents();
        if (!updatedStudents.some((student) => student.uid === pendingCheckout.studentId && student.paymentCompleted)) {
          setStatus('Payment is confirmed and subscription activation is still finishing. Check the status again shortly; do not start another payment.');
          return;
        }
        setPendingCheckout(null);
        setStatus('Payment confirmed and subscription activated.');
      } else if (['failed', 'abandoned', 'reversed', 'cancelled'].includes(paymentStatus)) {
        setPendingCheckout(null);
        setStatus(`The previous payment is confirmed as ${paymentStatus}. You can now start another checkout.`);
        await loadStudents();
      } else {
        setStatus('The previous payment is still processing. Its discount reservation will remain held until Paystack confirms the final status.');
      }
    } catch (error) {
      setStatus(error?.message || 'Could not check the previous payment status.');
    } finally {
      setLoading(false);
    }
  };

  const cancelAuthorizationCheckout = async () => {
    if (!pendingAuthorizationCheckout?.reference || !pendingAuthorizationCheckout?.studentId) return;
    setIsCancellingAuthorizationCheckout(true);
    try {
      const result = await runOperation({ operationName: 'Closing pending payment checkout', successMessage: 'The checkout status was confirmed.' }, () => cancelSubscriptionPaymentCheckout({
        studentId: pendingAuthorizationCheckout.studentId,
        reference: pendingAuthorizationCheckout.reference,
      }));
      if (result.paymentSucceeded) {
        const verification = await runOperation({ operationName: 'Verifying student payment', successMessage: 'Payment verification finished.', autoDismissMs: 1200 }, () => verifySubscriptionPayment(pendingAuthorizationCheckout.reference, pendingAuthorizationCheckout.studentId));
        if (verification?.status === 'success') {
          const updatedStudents = await loadStudents();
          if (!updatedStudents.some((student) => student.uid === pendingAuthorizationCheckout.studentId && student.paymentCompleted)) {
            throw new Error('Payment is verified but subscription activation is still finalizing. Retry verification; do not pay again.');
          }
          setStatus(`Payment verified and subscription activated. R1.00 authorization refund status: ${verification.refundStatus || 'pending'}.${verification.manualPaymentRequired ? ' Paystack did not provide a reusable authorization, so the next payment will need to be completed manually.' : ''}`);
          setPendingAuthorizationCheckout(null);
          return;
        }
      }
      setPendingAuthorizationCheckout(null);
      setStatus('Checkout closed. If Paystack payment was not completed, its discount reservation will be released after Paystack confirms abandonment.');
    } catch (error) {
      setStatus(error?.message || 'Could not close the pending checkout.');
    } finally {
      setIsCancellingAuthorizationCheckout(false);
    }
  };

  const unpaidCount = students.filter(s => !s.paymentCompleted).length;
  const selectedGroupStudents = students.filter((student) => groupStudentIds.includes(student.uid));
  const missingGroupSelections = selectedGroupStudents.filter((student) => !groupSelections[student.uid]);
  const beginGroupCheckout = () => {
    if (selectedGroupStudents.length < 2 || missingGroupSelections.length) return;
    void startGroupCheckout(selectedGroupStudents.map((student) => ({
      studentId: student.uid,
      displayName: student.displayName || student.email,
      selection: groupSelections[student.uid],
    })));
  };

  return (
    <AppShell
      title="Kids"
      subtitle="Link students, create managed profiles, and manage each child’s subscription."
      role="parent"
      user={profile}
      onLogout={logout}
    >
      <SectionHeader 
        eyebrow="Linked Students" 
        title="Your Children" 
        description="Add students using their email or Examifying ID. You can manage multiple students from this panel."
      />
      
      <div className="panel p-6 mb-8 flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 w-full">
          <label className="label block mb-2">Student Email</label>
          <input 
            type="text" 
            className="input w-full" 
            placeholder="e.g. ayanda@example.com"
            value={studentIdInput}
            onChange={(e) => setStudentIdInput(e.target.value)}
          />
        </div>
        <button 
          className="btn-primary whitespace-nowrap px-6 py-2 flex items-center gap-2 h-[42px]" 
          onClick={handleLinkStudent}
          disabled={loading || !studentIdInput.trim()}
        >
          <LinkIcon className="h-4 w-4" />
          Link Student
        </button>
      </div>

      <form onSubmit={handleCreateStudent} className="panel mb-8 grid gap-4 p-6 md:grid-cols-2" aria-label="Create a student profile">
        <div className="md:col-span-2">
          <h2 className="text-lg font-bold text-slate-950">Add a child without an account</h2>
          <p className="mt-1 text-sm text-slate-500">This creates a student profile in Firestore only. It does not create an authentication account.</p>
        </div>
        <label>
          <span className="label">Student’s full name</span>
          <input className="input w-full" value={newStudentName} onChange={(event) => setNewStudentName(event.target.value)} required maxLength={100} />
        </label>
        <label>
          <span className="label">Grade</span>
          <select className="input w-full" value={newStudentGrade} onChange={(event) => setNewStudentGrade(event.target.value)} required>
            {SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade').map((grade) => <option key={grade}>{grade}</option>)}
          </select>
        </label>
        <label>
          <span className="label">Province</span>
          <select className="input w-full" value={newStudentProvince} onChange={(event) => setNewStudentProvince(event.target.value)} required>
            <option value="">Select province</option>
            {REGIONS.filter((region) => region !== 'National').map((region) => <option key={region}>{region}</option>)}
          </select>
        </label>
        <label>
          <span className="label">School</span>
          <input className="input w-full" value={newStudentSchool} onChange={(event) => setNewStudentSchool(event.target.value)} required maxLength={160} />
        </label>
        <label className="md:col-span-2">
          <span className="label">WhatsApp number</span>
          <input type="tel" inputMode="tel" autoComplete="tel" className="input w-full" placeholder="082 123 4567 or +27 82 123 4567" value={newStudentWhatsApp} onChange={(event) => setNewStudentWhatsApp(event.target.value)} required />
          <span className="mt-1 block text-xs text-slate-500">Use a country code or a South African number beginning with 0.</span>
        </label>
        <div className="space-y-3 md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={autoGenerateEmail} onChange={(event) => setAutoGenerateEmail(event.target.checked)} />
            Generate a placeholder email from the child’s name and my email
          </label>
          {!autoGenerateEmail ? <label className="block">
            <span className="label">Student email</span>
            <input type="email" className="input w-full" value={newStudentEmail} onChange={(event) => setNewStudentEmail(event.target.value)} required />
          </label> : <p className="text-xs text-slate-500">The generated address uses the format child-name-parent-email-name@examifying.com. If already taken, a number is added.</p>}
        </div>
        <button type="submit" className="btn-primary inline-flex w-fit items-center gap-2 md:col-span-2" disabled={loading || !newStudentName.trim() || !newStudentProvince || !newStudentSchool.trim() || !newStudentWhatsApp.trim()}>
          <Plus className="h-4 w-4" aria-hidden="true" />{loading ? 'Creating…' : 'Create student profile'}
        </button>
      </form>
      
      {status && (
        <div className="mb-6 p-4 rounded-xl border border-lime-400/30 bg-lime-400/10 text-lime-300 flex flex-wrap items-center gap-2 text-sm font-medium">
          <AlertCircle className="w-4 h-4" />
          {status}
          {pendingCheckout?.reference ? (
            <button type="button" className="btn-primary ml-auto shrink-0 px-4 py-2" onClick={checkPendingCheckout} disabled={loading}>
              {loading ? 'Checking…' : 'Check payment status'}
            </button>
          ) : null}
        </div>
      )}

      {students.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-lime-400/30 bg-lime-400/10 p-6 shadow-sm">
          <div>
            <h3 className="font-bold text-white text-lg">Payments</h3>
            <p className="text-slate-300 text-sm mt-1">{unpaidCount} student{unpaidCount !== 1 ? 's' : ''} need a subscription. Choose a plan for each student.</p>
          </div>
          <button type="button" className="btn-primary" onClick={() => { setGroupSelections({}); setGroupCheckoutOpen(true); }} disabled={groupStudentIds.length < 2 || loading}>
            Pay for selected kids ({groupStudentIds.length})
          </button>
        </div>
      )}

      {!studentsLoaded ? <LoadingState label="Loading your linked students and summaries…" /> : students.length === 0 ? (
        <div className="py-12 bg-slate-900/60 rounded-2xl border border-dashed border-slate-700 flex flex-col items-center justify-center text-slate-400">
          <Users className="h-12 w-12 text-slate-500 mb-4" />
          <p className="text-lg font-medium text-white">No students linked yet</p>
          <p className="text-sm">Link your child's account above to view their progress and manage payments.</p>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {students.map((student) => (
            <div key={student.uid} className="panel p-0 flex flex-col overflow-hidden">
              <div className="bg-slate-900/90 p-6 border-b border-slate-800 flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-bold text-white">{student.displayName || student.email}</h3>
                  <p className="text-sm text-slate-400">{student.grade || 'Unknown Grade'} • {student.province || 'Unknown Region'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                    <input type="checkbox" checked={groupStudentIds.includes(student.uid)} onChange={(event) => setGroupStudentIds((current) => event.target.checked ? [...current, student.uid] : current.filter((id) => id !== student.uid))} aria-label={`Select ${student.displayName || 'student'} for group checkout`} />
                    Group
                  </label>
                  <button
                    onClick={() => setEditingStudentId(editingStudentId === student.uid ? null : student.uid)}
                    className="p-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-lime-400 hover:border-lime-400/50 transition-colors"
                    title="Edit Profile"
                  >
                    <Edit className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="p-6 flex-1 flex flex-col">
                {editingStudentId === student.uid ? (
                  <EditDetailsForm 
                    student={student} 
                    onSave={(form) => handleSaveDetails(student.uid, form)}
                    onCancel={() => setEditingStudentId(null)}
                  />
                ) : (
                  <>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Progress & Status</h4>
                    <div className="space-y-4 mb-6">
                      {student.summaryUnavailable ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Student progress and subscription details could not be loaded. The linked student is still available; retry the status check below.</p> : student.todayExerciseUnavailable || student.completedLessonsUnavailable ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Some progress details could not be loaded. Subscription status is shown separately; retry the progress check below.</p> : null}
                      <div className="flex items-center gap-3">
                        <Activity className="w-5 h-5 text-brand-600" />
                        <div>
                          <p className="text-sm font-medium text-slate-900">{student.summaryUnavailable ? 'Progress unavailable' : student.completedLessonsUnavailable ? `${student.completedLessonsCount} Completed Topics (partial)` : `${student.completedLessonsCount} Completed Topics`}</p>
                          <p className="text-xs text-slate-500">Starting Mark: {student.previousYearMark || 0}%</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <Calendar className={`w-5 h-5 ${student.todayExercise ? 'text-emerald-600' : 'text-slate-400'}`} />
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            {student.summaryUnavailable || student.todayExerciseUnavailable ? 'Exercise status unavailable' : student.todayExercise ? 'Today\'s Exercise Available' : 'No Exercise Today'}
                          </p>
                          {student.todayExercise && (
                            <p className="text-xs text-slate-500 truncate max-w-[200px]" title={student.todayExercise.title}>
                              {student.todayExercise.submittedImageUrl ? '✅ Submitted' : '⏳ Pending'} • {student.todayExercise.title}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                <div className="mt-auto pt-4 border-t border-slate-100">
                  <Link to={`/parent/kids/${student.uid}`} className="btn-secondary mb-4 inline-flex w-full items-center justify-center">Open student workspace</Link>
                  <div className="flex justify-between items-center mb-4 text-sm">
                    <span className="text-slate-500">Subscription Status</span>
                    <span className={`font-semibold px-2 py-1 rounded-md text-xs ${student.summaryUnavailable ? 'bg-slate-100 text-slate-600' : student.subscriptionStatus === 'past_due' ? 'bg-amber-50 text-amber-700' : student.paymentCompleted ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {student.summaryUnavailable ? 'Status unavailable' : student.subscriptionStatus === 'past_due' ? 'Payment due' : student.cancelAtPeriodEnd ? 'Ends this period' : student.paymentCompleted ? 'Active' : 'Free'}
                    </span>
                  </div>

                  {student.summaryUnavailable || student.todayExerciseUnavailable || student.completedLessonsUnavailable ? (
                    <button className="btn-secondary w-full" onClick={() => void loadStudents()} disabled={loading}>Retry student status</button>
                  ) : !student.paymentCompleted ? (
                    <button 
                      className="btn-primary w-full" 
                      onClick={() => setSubscriptionStudent(student)}
                      disabled={loading}
                    >
                      Choose subscription
                    </button>
                  ) : (
                    <button className="btn-secondary w-full" onClick={() => setSubscriptionStudent(student)} disabled={loading}>
                      {student.paymentCompleted ? 'Manage subscription' : 'Choose subscription'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {groupCheckoutOpen ? (
        <div className="fixed inset-0 z-[80] overflow-y-auto bg-slate-950/95 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Group student subscription checkout">
          <div className="mx-auto my-4 max-w-6xl space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Group checkout</p>
                <h2 className="mt-1 text-2xl font-bold text-white">Choose a plan for each child</h2>
                <p className="mt-2 max-w-3xl text-sm text-slate-300">Each child keeps an individual subscription and payment record. Paystack opens separately for each child so their card authorization stays with their own student record.</p>
              </div>
              <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setGroupCheckoutOpen(false)} aria-label="Close group checkout"><X className="h-5 w-5" /></button>
            </div>
            {selectedGroupStudents.length < 2 ? <p className="panel p-4 text-sm text-amber-800">Select at least two kids on this page to continue with group checkout.</p> : null}
            {selectedGroupStudents.map((student) => (
              <section key={student.uid} className="panel space-y-4 p-5">
                <h3 className="text-lg font-bold text-white">{student.displayName || student.email}</h3>
                <SubscriptionPlanSelector
                  studentId={student.uid}
                  selectionOnly
                  onSelectionChange={updateGroupSelection}
                  initialDiscountCode={new URLSearchParams(location.search).get('discountCode') || ''}
                  initialSelection={{
                    planId: ['circle', 'personalized'].includes(student.subscriptionPlanId) ? student.subscriptionPlanId : 'circle',
                    billingPeriod: student.subscriptionBillingPeriod || 'monthly',
                    subjectCount: student.subscriptionSubjectCount || 1,
                  }}
                />
              </section>
            ))}
            {missingGroupSelections.length ? <p className="text-sm text-amber-200" role="status">Choose a subscription for each selected child before checkout.</p> : null}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn-secondary" onClick={() => setGroupCheckoutOpen(false)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={beginGroupCheckout} disabled={loading || selectedGroupStudents.length < 2 || missingGroupSelections.length > 0}>
                {loading ? 'Preparing checkout…' : `Checkout ${selectedGroupStudents.length} kids`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {subscriptionStudent ? (
        <div className="fixed inset-0 z-[80] overflow-y-auto bg-slate-950/95 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Subscription for ${subscriptionStudent.displayName || 'student'}`}>
          <div className="mx-auto my-4 max-w-6xl">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Student subscription</p>
                <h2 className="mt-1 text-2xl font-bold text-white">{subscriptionStudent.displayName || subscriptionStudent.email}</h2>
              </div>
              <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setSubscriptionStudent(null)} aria-label="Close subscription plans"><X className="h-5 w-5" /></button>
            </div>
            <div className="mb-5">
              <SubscriptionLifecyclePanel
                studentId={subscriptionStudent.uid}
                subscriptionState={subscriptionStudent}
                onStateChange={(nextState) => {
                  setSubscriptionStudent((current) => current ? { ...current, ...nextState } : current);
                  loadStudents();
                }}
                onContinuePayment={() => {
                  const selection = subscriptionStudent.pendingPlan || subscriptionStudent;
                  handlePayForStudent(subscriptionStudent, {
                    planId: selection.planId || subscriptionStudent.subscriptionPlanId,
                    billingPeriod: selection.billingPeriod || subscriptionStudent.subscriptionBillingPeriod || 'monthly',
                    subjectCount: selection.subjectCount || subscriptionStudent.subscriptionSubjectCount || 1,
                    discountCode: selection.discountCode || '',
                  });
                }}
              />
            </div>
            <SubscriptionPlanSelector
              studentId={subscriptionStudent.uid}
              initialDiscountCode={new URLSearchParams(location.search).get('discountCode') || subscriptionStudent.pendingPlan?.discountCode || ''}
              key={`${subscriptionStudent.pendingPlan?.planId || subscriptionStudent.subscriptionPlanId}-${subscriptionStudent.pendingPlan?.billingPeriod || subscriptionStudent.subscriptionBillingPeriod}-${subscriptionStudent.pendingPlan?.subjectCount || subscriptionStudent.subscriptionSubjectCount}-${subscriptionStudent.pendingPlan?.discountCode || ''}`}
              initialSelection={{
                planId: subscriptionStudent.pendingPlan?.planId || subscriptionStudent.subscriptionPlanId,
                billingPeriod: subscriptionStudent.pendingPlan?.billingPeriod || subscriptionStudent.subscriptionBillingPeriod,
                subjectCount: subscriptionStudent.pendingPlan?.subjectCount || subscriptionStudent.subscriptionSubjectCount,
              }}
              onContinue={(selection) => handlePayForStudent(subscriptionStudent, selection)}
              isSubmitting={loading}
            />
            <AuthorizationChargeDisclosure
              checkout={pendingAuthorizationCheckout}
              isCancelling={isCancellingAuthorizationCheckout}
              onContinue={() => { if (pendingAuthorizationCheckout?.authorizationUrl) window.location.assign(pendingAuthorizationCheckout.authorizationUrl); }}
              onCancel={cancelAuthorizationCheckout}
            />
          </div>
        </div>
      ) : null}
    </AppShell>
  );
};
