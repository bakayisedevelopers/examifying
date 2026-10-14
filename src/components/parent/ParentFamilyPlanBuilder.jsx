import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Users } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SubscriptionPlanSelector } from '../billing/SubscriptionPlanSelector';
import { useAuth } from '../../hooks/useAuth';
import { calculateSubscriptionQuote } from '../../utils/subscriptionPlans';
import { previewParentFamilyDiscount, saveParentFamilyCheckoutDraft } from '../../services/parentFamilyService';
import { encodeParentFamilyPlanDraft } from '../../utils/parentFamilyPlanDraft';

export const PARENT_FAMILY_DRAFT_STORAGE_KEY = 'examifying-parent-family-draft';

const newDraftId = () => globalThis.crypto?.randomUUID?.() || `family-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const formatRand = (amount) => `R${Number(amount || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const defaultSlot = () => ({ planId: 'circle', billingPeriod: 'monthly', subjectCount: 1 });

const FamilyStudentPlan = ({ index, slot, discountCode, onChange }) => {
  const handleSelectionChange = useCallback((selection) => onChange(index, selection), [index, onChange]);
  return (
    <article className="rounded-2xl border border-white/10 bg-slate-950/45 p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-400/10 text-lime-300"><Users className="h-5 w-5" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">Student {index + 1}</p>
          <h3 className="font-semibold text-white">Choose this student&apos;s plan</h3>
        </div>
      </div>
      <SubscriptionPlanSelector
        selectionOnly
        enableYearly
        idPrefix={`family-${index + 1}`}
        initialSelection={slot}
        initialDiscountCode={discountCode}
        hideDiscountInput
        onSelectionChange={handleSelectionChange}
      />
    </article>
  );
};

export const ParentFamilyPlanBuilder = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const initialCode = new URLSearchParams(location.search).get('discountCode')?.trim().toUpperCase() || '';
  const [studentCount, setStudentCount] = useState(1);
  const [slots, setSlots] = useState([defaultSlot()]);
  const [discountCode, setDiscountCode] = useState(initialCode);
  const [discountPreview, setDiscountPreview] = useState(null);
  const [discountStatus, setDiscountStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSlots((current) => Array.from({ length: studentCount }, (_, index) => current[index] || defaultSlot()));
  }, [studentCount]);

  useEffect(() => {
    setDiscountPreview(null);
    if (discountCode.length !== 10) return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      void previewParentFamilyDiscount({ discountCode, slots }).then((preview) => {
        if (!active) return;
        setDiscountPreview(preview);
        setDiscountStatus(preview.valid ? 'Discount applied to eligible student subscriptions.' : (preview.message || 'This discount cannot be applied to all selected plans.'));
      }).catch((error) => {
        if (active) setDiscountStatus(error?.message || 'This discount could not be checked.');
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [discountCode, slots]);

  const onSlotChange = useCallback((index, selection) => {
    setSlots((current) => current.map((slot, slotIndex) => slotIndex === index ? { ...slot, ...selection } : slot));
  }, []);

  const slotAmounts = useMemo(() => slots.map((slot) => calculateSubscriptionQuote({
    planId: slot.planId,
    billingPeriod: slot.billingPeriod,
    subjectCount: slot.subjectCount,
  }).amount), [slots]);
  const previewQuotes = discountPreview?.valid && discountPreview.quotes?.length === slots.length
    ? discountPreview.quotes : null;
  const total = previewQuotes
    ? Number(discountPreview.totalAmount || 0)
    : slotAmounts.reduce((sum, amount) => sum + amount, 0);

  const applyDiscount = async () => {
    const normalized = discountCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    setDiscountCode(normalized);
    setDiscountPreview(null);
    setDiscountStatus('');
    if (!normalized) return;
    if (normalized.length !== 10) {
      setDiscountStatus('Enter all 10 characters to check this discount.');
      return;
    }
    try {
      const preview = await previewParentFamilyDiscount({ discountCode: normalized, slots });
      setDiscountPreview(preview);
      setDiscountStatus(preview.valid ? `Discount applied to eligible student subscriptions.` : (preview.message || 'This discount cannot be applied to all selected plans.'));
    } catch (error) {
      setDiscountStatus(error?.message || 'This discount could not be checked.');
    }
  };

  const continueFamilySetup = async () => {
    setSaving(true);
    setDiscountStatus('');
    const draftId = newDraftId();
    const payload = {
      draftId,
      discountCode: discountCode.trim().toUpperCase(),
      slots: slots.map(({ planId, billingPeriod, subjectCount }) => ({ planId, billingPeriod, subjectCount })),
    };
    try {
      if (profile?.role === 'parent') {
        await saveParentFamilyCheckoutDraft(payload);
        navigate(`/parent/family-setup?draftId=${encodeURIComponent(draftId)}`);
        return;
      }
      const serializedPlan = encodeParentFamilyPlanDraft(payload);
      try { window.localStorage.setItem(PARENT_FAMILY_DRAFT_STORAGE_KEY, serializedPlan); } catch { /* The signup URL also carries this draft. */ }
      const signupParams = new URLSearchParams({ familyDraftId: draftId, familyPlan: serializedPlan });
      navigate(`/signup?${signupParams.toString()}`);
    } catch (error) {
      setDiscountStatus(error?.message || 'Could not save this family plan. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="parent-pricing" aria-labelledby="parent-pricing-title" className="mt-12 scroll-mt-24 rounded-3xl border border-lime-300/20 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/60 p-5 shadow-[0_20px_70px_rgba(16,185,129,0.08)] sm:p-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-300">Family subscriptions</p>
          <h2 id="parent-pricing-title" className="mt-2 text-2xl font-black text-white sm:text-3xl">Build a plan for each child</h2>
        </div>
        <p className="max-w-xl text-sm leading-6 text-slate-300">Choose a separate plan and subject count for every child. We’ll show one family total while each child keeps an individual subscription and renewal record.</p>
      </div>
      <div className="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-slate-950/35 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-end">
        <label className="block">
          <span className="label text-slate-200">Number of students</span>
          <select className="input" value={studentCount} onChange={(event) => setStudentCount(Number(event.target.value))}>
            {Array.from({ length: 20 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} {count === 1 ? 'student' : 'students'}</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="min-w-0 flex-1">
            <span className="label text-slate-200">Discount code</span>
            <input className="input font-mono uppercase tracking-wider" value={discountCode} maxLength={10} onChange={(event) => { setDiscountCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); setDiscountPreview(null); }} placeholder="Enter a code or use a discount link" aria-label="Family discount code" />
          </label>
          <button type="button" className="btn-secondary h-11 self-end px-5" onClick={applyDiscount} disabled={!discountCode || discountCode.length !== 10}>Apply code</button>
        </div>
      </div>
      {discountStatus ? <p role="status" className={`mt-3 text-sm ${discountPreview?.valid ? 'text-lime-300' : 'text-amber-200'}`}>{discountStatus}</p> : null}
      <div className="mt-5 space-y-4">
        {slots.map((slot, index) => <FamilyStudentPlan key={index} index={index} slot={slot} discountCode={discountCode} onChange={onSlotChange} />)}
      </div>
      <div className="mt-5 rounded-2xl border border-lime-300/25 bg-slate-950/50 p-5">
        <div className="space-y-2">
          {slots.map((slot, index) => {
            const baseAmount = slotAmounts[index] || 0;
            const quote = previewQuotes?.find((entry) => entry.slotIndex === index);
            const amount = quote?.finalAmount ?? baseAmount;
            return <div key={index} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-300">Student {index + 1} · {slot.planId === 'personalized' ? 'Personalized' : 'Circle'} · {slot.subjectCount} {slot.subjectCount === 1 ? 'subject' : 'subjects'} · {slot.billingPeriod}</span>
              <span className="text-right font-semibold text-white">
                {quote && Number(quote.originalAmount) > Number(amount) ? <del className="mr-2 text-sm font-normal text-slate-400">{formatRand(quote.originalAmount)}</del> : null}
                {formatRand(amount)}
              </span>
            </div>;
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-white/10 pt-4">
          <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-lime-300">Family total</p><p className="mt-1 text-3xl font-black text-white">{formatRand(total)}</p></div>
          <button type="button" className="btn-primary inline-flex items-center gap-2 px-6 py-3" onClick={continueFamilySetup} disabled={saving}>
            {saving ? 'Saving family plan…' : 'Continue'}<ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-400">The final amount and discount eligibility are confirmed before checkout. A saved card can be reused for future student renewals.</p>
    </section>
  );
};
