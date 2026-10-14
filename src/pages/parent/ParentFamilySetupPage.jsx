import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CreditCard, Plus, ShieldCheck } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { REGIONS, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { createManagedStudentProfileForParent, getStudentsForParent } from '../../services/firestoreService';
import { attachStudentsToParentFamilyCheckoutDraft, getParentFamilyCheckoutDraft, previewParentFamilyDiscount, saveParentFamilyCheckoutDraft } from '../../services/parentFamilyService';
import { getParentSavedPaymentMethods, initializeFamilySubscriptionCheckout, verifyFamilySubscriptionCheckout } from '../../services/paymentsService';
import { calculateSubscriptionQuote } from '../../utils/subscriptionPlans';

const randomId = () => globalThis.crypto?.randomUUID?.() || `family-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const blankStudent = (existing = false) => ({
  mode: existing ? 'existing' : 'new', studentId: '', displayName: '', grade: 'Grade 10', province: '', school: '', whatsappNumber: '', email: '', autoGenerateEmail: true,
});
const formatRand = (value) => `R${Number(value || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const ParentFamilySetupPage = () => {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(null);
  const [draftId, setDraftId] = useState(new URLSearchParams(location.search).get('draftId') || '');
  const [linkedStudents, setLinkedStudents] = useState([]);
  const [studentForms, setStudentForms] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [paymentMode, setPaymentMode] = useState('new');
  const [selectedMethodId, setSelectedMethodId] = useState('');
  const [step, setStep] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [verificationReference, setVerificationReference] = useState('');
  const [verificationAttempts, setVerificationAttempts] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const verifyingRef = useRef('');

  const loadFamily = useCallback(async () => {
    if (!profile?.uid) return;
    setStep('loading');
    try {
      let requestedDraftId = new URLSearchParams(location.search).get('draftId') || draftId;
      if (!requestedDraftId) {
        requestedDraftId = randomId();
        const discountCode = new URLSearchParams(location.search).get('discountCode') || '';
        await saveParentFamilyCheckoutDraft({
          draftId: requestedDraftId,
          discountCode,
          slots: [{ planId: 'circle', billingPeriod: 'monthly', subjectCount: 1 }],
        });
        navigate(`/parent/family-setup?draftId=${encodeURIComponent(requestedDraftId)}`, { replace: true });
      }
      const [loadedDraft, students] = await Promise.all([
        getParentFamilyCheckoutDraft({ draftId: requestedDraftId }),
        getStudentsForParent(profile.uid),
      ]);
      const savedMethods = await getParentSavedPaymentMethods().catch((error) => {
        setStatus(`Saved cards could not be loaded. You can still choose a new card. ${error?.message || ''}`.trim());
        return { paymentMethods: [] };
      });
      setDraftId(requestedDraftId);
      setDraft(loadedDraft);
      setLinkedStudents(students);
      const attachedIds = Array.isArray(loadedDraft.studentIds) ? loadedDraft.studentIds : [];
      if (loadedDraft.status === 'students_attached' || loadedDraft.status === 'checkout_started') {
        setStudentForms(loadedDraft.slots.map((slot, index) => ({ ...blankStudent(false), mode: 'existing', studentId: attachedIds[index] || '' })));
        setStep('payment');
      } else if (loadedDraft.status === 'completed') {
        setStep('complete');
      } else {
        setStudentForms(loadedDraft.slots.map((_, index) => blankStudent(students.length > 0 && index < students.length)));
        setStep('students');
      }
      setPaymentMethods(savedMethods.paymentMethods || []);
      if (savedMethods.paymentMethods?.length) {
        setPaymentMode('existing');
        setSelectedMethodId(savedMethods.paymentMethods[0].id);
      }
    } catch (error) {
      setStatus(error?.message || 'Could not load this family setup.');
      setStep('error');
    }
  }, [draftId, location.search, navigate, profile?.uid]);

  useEffect(() => { void loadFamily(); }, [loadFamily]);

  useEffect(() => {
    if (!draft?.slots?.length) return;
    const baseTotal = draft.slots.reduce((sum, slot) => sum + calculateSubscriptionQuote(slot).amount, 0);
    setTotalAmount(baseTotal);
    const discountCode = draft.slots[0]?.discountCode || '';
    if (discountCode.length !== 10) return;
    let active = true;
    void previewParentFamilyDiscount({ discountCode, slots: draft.slots }).then((preview) => {
      if (active && preview.valid) setTotalAmount(Number(preview.totalAmount || 0));
    }).catch(() => {});
    return () => { active = false; };
  }, [draft]);

  const verifyReference = useCallback(async (reference) => {
    if (!reference || !profile?.uid || verifyingRef.current === reference) return;
    verifyingRef.current = reference;
    setBusy(true);
    setStatus('Checking the family payment and activating subscriptions…');
    try {
      const result = await verifyFamilySubscriptionCheckout(reference);
      if (result.status === 'success') {
        setStatus(result.charged === false || result.totalAmount === 0
          ? 'Family subscriptions are active. No amount was charged to the saved card.'
          : 'Payment verified. The selected subscriptions are active for your children.');
        setStep('complete');
        setVerificationReference('');
        setVerificationAttempts(0);
        await loadFamily();
        setStep('complete');
      } else if (['pending', 'processing', 'ongoing', 'initialized', 'initializing'].includes(result.status)) {
        setVerificationAttempts((count) => count + 1);
        setVerificationReference(reference);
        setStatus('Paystack is still confirming the payment. We’ll check again automatically; please don’t start another checkout.');
      } else {
        setVerificationReference('');
        setStatus(`Family payment status: ${result.status || 'unknown'}. Your linked student profiles are still saved; contact support before trying again.`);
      }
    } catch (error) {
      setVerificationAttempts((count) => count + 1);
      setVerificationReference(reference);
      setStatus(error?.message || 'Payment verification is still in progress. Please wait before retrying.');
    } finally {
      verifyingRef.current = '';
      setBusy(false);
    }
  }, [loadFamily, profile?.uid]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (params.get('familyCheckout') !== '1' || !reference || reference === verifyingRef.current) return;
    setVerificationReference(reference);
    setVerificationAttempts(0);
    void verifyReference(reference);
  }, [location.search, verifyReference]);

  useEffect(() => {
    if (!verificationReference || verificationAttempts >= 8 || busy) return undefined;
    const timer = window.setTimeout(() => void verifyReference(verificationReference), 8000);
    return () => window.clearTimeout(timer);
  }, [busy, verificationAttempts, verificationReference, verifyReference]);

  const updateStudentForm = (index, update) => setStudentForms((current) => current.map((student, studentIndex) => studentIndex === index ? { ...student, ...update } : student));

  const saveStudents = async (event) => {
    event.preventDefault();
    if (!profile?.uid || !draft || studentForms.length !== draft.slots.length) return;
    setBusy(true);
    setStatus('');
    try {
      const ids = [];
      for (const [index, entry] of studentForms.entries()) {
        let studentId = entry.studentId;
        if (entry.mode === 'existing') {
          if (!studentId) throw new Error('Choose a linked student for every existing-student slot.');
        } else {
          const created = await createManagedStudentProfileForParent({
            parentId: profile.uid,
            displayName: entry.displayName,
            grade: entry.grade,
            province: entry.province,
            school: entry.school,
            whatsappNumber: entry.whatsappNumber,
            email: entry.email,
            autoGenerateEmail: entry.autoGenerateEmail,
          });
          studentId = created.uid || created.id;
          updateStudentForm(index, { mode: 'existing', studentId });
          setLinkedStudents((current) => current.some((student) => student.uid === studentId) ? current : [...current, { ...created, uid: studentId }]);
        }
        if (!studentId || ids.includes(studentId)) throw new Error('Select a different student in each family slot.');
        ids.push(studentId);
      }
      await attachStudentsToParentFamilyCheckoutDraft({ draftId, studentIds: ids });
      const updatedStudents = await getStudentsForParent(profile.uid);
      const savedMethods = await getParentSavedPaymentMethods().catch((error) => {
        setStatus(`Saved cards could not be loaded. You can still choose a new card. ${error?.message || ''}`.trim());
        return { paymentMethods: [] };
      });
      setLinkedStudents(updatedStudents);
      setPaymentMethods(savedMethods.paymentMethods || []);
      setDraft((current) => ({ ...current, status: 'students_attached', studentIds: ids }));
      setStep('payment');
      setStatus('Student profiles are ready. Choose a payment method to continue.');
    } catch (error) {
      setStatus(error?.message || 'Could not save the student profiles.');
      const refreshed = await getStudentsForParent(profile.uid).catch(() => null);
      if (refreshed) setLinkedStudents(refreshed);
    } finally {
      setBusy(false);
    }
  };

  const beginCheckout = async () => {
    if (!draftId || !draft?.studentIds?.length || busy) return;
    if (paymentMode === 'existing' && !selectedMethodId) {
      setStatus('Choose a saved card or select the new-card option.');
      return;
    }
    setBusy(true);
    setStatus('Preparing family checkout…');
    setVerificationAttempts(0);
    const checkoutId = `family-${randomId()}`;
    try {
      const result = await initializeFamilySubscriptionCheckout({
        draftId,
        checkoutId,
        paymentMode,
        ...(paymentMode === 'existing' ? { paymentMethodId: selectedMethodId } : {}),
        callbackUrl: `${window.location.origin}/parent/family-setup?draftId=${encodeURIComponent(draftId)}`,
      });
      setTotalAmount(Number(result.totalAmount || 0));
      if (result.authorizationUrl) {
        setStatus('Opening Paystack…');
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (result.status === 'success' || result.completed) {
        setStatus(result.charged === false || result.totalAmount === 0
          ? 'Family subscriptions are active. No amount was charged to the saved card.'
          : 'Payment verified. The selected subscriptions are active for your children.');
        setStep('complete');
        await loadFamily();
        setStep('complete');
        return;
      }
      if (result.reference) {
        setVerificationReference(result.reference);
        setVerificationAttempts(0);
        setStatus('Paystack is confirming the payment. We’ll check the result automatically; please don’t start another checkout.');
      } else {
        setStatus('Checkout has not completed. Your student profiles remain saved.');
      }
    } catch (error) {
      setStatus(error?.message || 'Could not start the family checkout. Your student profiles remain saved.');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'loading') return <main className="min-h-screen bg-slate-950 p-8"><LoadingState label="Loading family subscription setup…" /></main>;

  return (
    <AppShell title="Set up your children’s subscriptions" subtitle="Add or link each child from your saved plan, then choose a saved card or a new card to finish checkout." role="parent" user={profile} onLogout={logout}>
      <main className="mx-auto max-w-4xl space-y-6 pb-12">
        <section className="panel p-5 sm:p-7">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-400">Family setup · {step === 'students' ? 'Step 1 of 2' : step === 'payment' ? 'Step 2 of 2' : step === 'complete' ? 'Complete' : 'Setup'}</p>
          <h1 className="mt-2 text-2xl font-black text-white">{step === 'complete' ? 'Subscriptions activated' : step === 'payment' ? 'Choose a payment method' : 'Add the students'}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">This step connects each plan you selected to a child profile. Each student keeps an individual subscription, payment record, and renewal amount. A parent card can be reused for each student’s future renewal.</p>
          {status ? <p role="status" className="mt-4 rounded-xl border border-lime-300/20 bg-lime-300/5 p-3 text-sm text-lime-100">{status}</p> : null}
        </section>

        {step === 'error' ? <section className="panel p-6"><p className="text-amber-200">{status}</p><button className="btn-secondary mt-4" onClick={() => void loadFamily()}>Retry</button></section> : null}

        {step === 'students' ? <form onSubmit={saveStudents} className="space-y-4">
          {studentForms.map((entry, index) => <section key={index} className="panel space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-lime-400">Student {index + 1}</p><h2 className="mt-1 text-lg font-bold text-white">Student details</h2></div>
              <div className="flex rounded-lg border border-white/10 p-1 text-xs">
                <button type="button" onClick={() => updateStudentForm(index, { mode: 'new' })} className={`rounded-md px-3 py-2 ${entry.mode === 'new' ? 'bg-lime-400 text-slate-950' : 'text-slate-300'}`}>Add new</button>
                <button type="button" onClick={() => updateStudentForm(index, { mode: 'existing' })} className={`rounded-md px-3 py-2 ${entry.mode === 'existing' ? 'bg-lime-400 text-slate-950' : 'text-slate-300'}`} disabled={!linkedStudents.length}>Use linked student</button>
              </div>
            </div>
            {entry.mode === 'existing' ? <label className="block"><span className="label">Linked student</span><select className="input w-full" value={entry.studentId} onChange={(event) => updateStudentForm(index, { studentId: event.target.value })} required><option value="">Select a student</option>{linkedStudents.map((student) => <option key={student.uid} value={student.uid}>{student.displayName || student.email} · {student.grade || 'Grade not set'}</option>)}</select></label> : <>
              <div className="grid gap-4 sm:grid-cols-2">
                <label><span className="label">Student’s full name</span><input className="input w-full" value={entry.displayName} onChange={(event) => updateStudentForm(index, { displayName: event.target.value })} required maxLength={100} /></label>
                <label><span className="label">Grade</span><select className="input w-full" value={entry.grade} onChange={(event) => updateStudentForm(index, { grade: event.target.value })} required>{SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade').map((grade) => <option key={grade}>{grade}</option>)}</select></label>
                <label><span className="label">Province</span><select className="input w-full" value={entry.province} onChange={(event) => updateStudentForm(index, { province: event.target.value })} required><option value="">Select province</option>{REGIONS.filter((region) => region !== 'National').map((region) => <option key={region}>{region}</option>)}</select></label>
                <label><span className="label">School</span><input className="input w-full" value={entry.school} onChange={(event) => updateStudentForm(index, { school: event.target.value })} required maxLength={160} /></label>
                <label><span className="label">WhatsApp number</span><input type="tel" className="input w-full" value={entry.whatsappNumber} onChange={(event) => updateStudentForm(index, { whatsappNumber: event.target.value })} placeholder="082 123 4567" required /></label>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={entry.autoGenerateEmail} onChange={(event) => updateStudentForm(index, { autoGenerateEmail: event.target.checked })} />Generate a placeholder email address</label>
              {!entry.autoGenerateEmail ? <label className="block"><span className="label">Student email</span><input type="email" className="input w-full" value={entry.email} onChange={(event) => updateStudentForm(index, { email: event.target.value })} required /></label> : <p className="text-xs text-slate-500">A student can replace this placeholder email when they create their own sign-in account.</p>}
            </>}
          </section>)}
          <button type="submit" className="btn-primary inline-flex items-center gap-2" disabled={busy}><Plus className="h-4 w-4" />{busy ? 'Saving students…' : 'Continue to payment'}</button>
        </form> : null}

        {step === 'payment' ? <section className="panel space-y-5 p-5 sm:p-7">
          <div>
            <h2 className="text-xl font-bold text-white">{draft?.slots?.length === 1 ? `Subscription total: ${formatRand(totalAmount)}` : `Family total: ${formatRand(totalAmount)}`}</h2>
            <p className="mt-1 text-sm text-slate-400">Review the students and plans attached to this checkout. The final prices are confirmed by the subscription service.</p>
          </div>
          <div className="divide-y divide-white/10 rounded-xl border border-white/10 bg-slate-950/35 px-4">
            {draft?.slots?.map((slot, index) => {
              const student = linkedStudents.find((entry) => entry.uid === draft.studentIds?.[index]);
              return <div key={`${draft.studentIds?.[index] || index}-${slot.planId}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="font-semibold text-white">{student?.displayName || student?.email || `Student ${index + 1}`}</span>
                <span className="text-slate-300">{slot.planId === 'personalized' ? 'Personalized' : 'Circle'} · {slot.subjectCount} {slot.subjectCount === 1 ? 'subject' : 'subjects'} · {slot.billingPeriod}</span>
              </div>;
            })}
          </div>
          <div className="space-y-3">
            <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${paymentMode === 'new' ? 'border-lime-400/60 bg-lime-400/5' : 'border-white/10'}`}>
              <input type="radio" name="family-payment" checked={paymentMode === 'new'} onChange={() => setPaymentMode('new')} className="mt-1" />
              <span><span className="block font-semibold text-white">Use a new card</span><span className="text-sm text-slate-400">Continue to Paystack and authorize this card for the selected children.</span></span>
            </label>
            {paymentMethods.length ? <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${paymentMode === 'existing' ? 'border-lime-400/60 bg-lime-400/5' : 'border-white/10'}`}>
              <input type="radio" name="family-payment" checked={paymentMode === 'existing'} onChange={() => setPaymentMode('existing')} className="mt-1" />
              <span className="block flex-1"><span className="block font-semibold text-white">Use an existing saved card</span><span className="text-sm text-slate-400">Charge the family total once; save the reusable authorization on each child’s subscription.</span></span>
            </label> : <p className="rounded-xl border border-white/10 p-4 text-sm text-slate-400">No reusable parent card is available yet. Choose a new card to continue.</p>}
            {paymentMode === 'existing' ? <div className="space-y-2 pl-8">{paymentMethods.map((method) => <label key={method.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${selectedMethodId === method.id ? 'border-lime-400/40 bg-lime-400/5' : 'border-white/10'}`}>
              <input type="radio" name="saved-family-card" checked={selectedMethodId === method.id} onChange={() => setSelectedMethodId(method.id)} />
              <CreditCard className="h-4 w-4 text-lime-300" />
              <span className="text-sm text-white">{method.cardType || 'Card'} ending in •••• {method.last4}</span>
              <span className="ml-auto text-xs text-slate-400">{method.expMonth && method.expYear ? `${String(method.expMonth).padStart(2, '0')}/${method.expYear}` : method.bank || ''}</span>
            </label>)}</div> : null}
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-slate-950/45 p-3 text-xs leading-5 text-slate-400"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-lime-300" />For a R0 family total, a saved card is not charged. A new card uses the existing R1 authorization and refund process.</div>
          <div className="flex flex-wrap gap-3"><button className="btn-primary" onClick={() => void beginCheckout()} disabled={busy || (paymentMode === 'existing' && !selectedMethodId)}>{busy ? 'Please wait…' : paymentMode === 'existing' ? 'Pay family total' : 'Continue to Paystack'}</button><button type="button" className="btn-secondary" onClick={() => setStep('students')} disabled={busy}>Back to student details</button></div>
          {verificationReference && verificationAttempts >= 8 ? <button type="button" className="text-sm font-semibold text-lime-300 underline" onClick={() => { setVerificationAttempts(0); void verifyReference(verificationReference); }} disabled={busy}>Check payment status</button> : null}
        </section> : null}

        {step === 'complete' ? <section className="panel p-6"><h2 className="text-xl font-bold text-white">Your children are ready</h2><p className="mt-2 text-sm text-slate-300">Their individual subscriptions and renewal details are active.</p><div className="mt-5 flex flex-wrap gap-3"><button className="btn-primary" onClick={() => navigate('/parent/kids')}>Open Kids</button><button className="btn-secondary" onClick={() => navigate('/parent')}>Family Home</button></div></section> : null}
      </main>
    </AppShell>
  );
};
