import { useState } from 'react';
import { ArrowRight, BookOpen, CheckCircle2, FileCheck2, GraduationCap, LockKeyhole, ShieldCheck, Users } from 'lucide-react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { useAuth } from '../hooks/useAuth';
import { getPortalConfig, getPortalForProfile, getSignupPathForPortal } from '../utils/portal';
import { calculateSubscriptionQuote } from '../utils/subscriptionPlans';

const portalContent = {
  teacher: {
    eyebrow: 'Maths teacher workspace',
    title: 'Connect your Maths lessons with learner progress and practice.',
    description: 'Review learner work, follow topic understanding, and keep Mathematics lessons connected to regular practice.',
    cards: [
      { icon: GraduationCap, title: 'Support your learners', body: 'Open the students connected to your teacher account.' },
      { icon: FileCheck2, title: 'Review exercise work', body: 'Use the existing submission, marking, and understanding-score tools.' },
      { icon: BookOpen, title: 'Plan the next steps', body: 'Keep lessons, completed topics, and student progress together.' },
    ],
  },
  tutor: {
    eyebrow: 'Online Maths tutor workspace',
    title: 'Help your Maths students make steady progress.',
    description: 'Review assigned learner work, follow topic understanding, and keep lessons and daily Maths practice connected in one place.',
    cards: [
      { icon: Users, title: 'Manage your learners', body: 'See the students connected to your tutor account.' },
      { icon: FileCheck2, title: 'Review their work', body: 'Open exercise submissions and use the existing marking and score tools.' },
      { icon: BookOpen, title: 'Keep learning moving', body: 'Work with exercises, topics, lessons, and progress reports.' },
    ],
  },
  parent: {
    eyebrow: 'Parent and caregiver portal',
    title: 'Be part of every child’s learning journey.',
    description: 'See your children’s daily learning, follow progress across their subjects, and manage each child’s learning from one family account.',
    cards: [
      { icon: GraduationCap, title: 'See each child’s day', body: 'Follow daily exercise completion across the subjects your children study.' },
      { icon: FileCheck2, title: 'Keep learning on track', body: 'Check progress and open a child’s learning space when they need support.' },
      { icon: ShieldCheck, title: 'Manage your family', body: 'Link children and manage their learning from one parent account.' },
    ],
  },
  admin: {
    eyebrow: 'Restricted administration',
    title: 'Examifying administration workspace.',
    description: 'Sign in with an administrator account to manage platform users, payments, settings, and learning resources.',
    cards: [
      { icon: Users, title: 'User administration', body: 'Review platform accounts and the existing role and access information.' },
      { icon: FileCheck2, title: 'Payments and codes', body: 'Access administration tools for payment records and discount codes.' },
      { icon: LockKeyhole, title: 'Protected access', body: 'Administrator access is granted by the Examifying platform owner.' },
    ],
  },
};

const formatRand = (amount) => new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  maximumFractionDigits: 0,
}).format(amount);

const ParentIndicativePricing = () => {
  const [studentCount, setStudentCount] = useState(1);
  const [subjectCount, setSubjectCount] = useState(1);
  const studentOptions = Array.from({ length: 20 }, (_, index) => index + 1);
  const subjectOptions = Array.from({ length: 20 }, (_, index) => index + 1);
  const plans = [
    { id: 'circle', name: 'Circle', extra: 'R49 for each additional subject' },
    { id: 'personalized', name: 'Personalized', extra: 'R599 for each additional subject' },
  ];

  return (
    <section id="parent-pricing" aria-labelledby="parent-pricing-title" className="mt-12 rounded-3xl border border-lime-300/20 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/60 p-5 shadow-[0_20px_70px_rgba(16,185,129,0.08)] sm:p-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-300">Indicative pricing</p>
          <h2 id="parent-pricing-title" className="mt-2 text-2xl font-black text-white sm:text-3xl">Estimate your family&apos;s monthly cost</h2>
        </div>
        <p className="max-w-xl text-sm leading-6 text-slate-300">Subscriptions stay separate for each child. Choose the number of students and subjects per student to compare estimated plan costs.</p>
      </div>
      <div className="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-slate-950/35 p-4 sm:grid-cols-2">
        <label className="block">
          <span className="label text-slate-200">Number of students</span>
          <select className="input" value={studentCount} onChange={(event) => setStudentCount(Number(event.target.value))}>
            {studentOptions.map((count) => <option key={count} value={count}>{count} {count === 1 ? 'student' : 'students'}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label text-slate-200">Subjects per student</span>
          <select className="input" value={subjectCount} onChange={(event) => setSubjectCount(Number(event.target.value))}>
            {subjectOptions.map((count) => <option key={count} value={count}>{count} {count === 1 ? 'subject' : 'subjects'}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {plans.map((plan) => {
          const monthlyPerStudent = calculateSubscriptionQuote({ planId: plan.id, billingPeriod: 'monthly', subjectCount }).monthlyAmount;
          return <article key={plan.id} className="rounded-2xl border border-lime-300/20 bg-slate-950/50 p-5">
            <p className="text-sm font-bold text-lime-200">{plan.name}</p>
            <p className="mt-2 text-3xl font-black text-white">{formatRand(monthlyPerStudent * studentCount)}<span className="ml-1 text-sm font-medium text-slate-400">/ month total</span></p>
            <p className="mt-2 text-sm text-slate-300">{formatRand(monthlyPerStudent)} per student × {studentCount} {studentCount === 1 ? 'student' : 'students'}</p>
            <p className="mt-3 text-xs text-slate-400">{plan.extra} per student each month.</p>
          </article>;
        })}
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-500">Indicative only. Each child&apos;s actual plan and subject count are selected separately in that child&apos;s subscription settings.</p>
    </section>
  );
};

const ParentMethodSection = () => (
  <section id="parent-method" aria-labelledby="parent-method-title" className="mt-12 scroll-mt-24 rounded-3xl border border-lime-300/20 bg-slate-900/70 p-5 sm:p-8">
    <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-300">The Examifying method</p>
    <h2 id="parent-method-title" className="mt-2 text-2xl font-black text-white sm:text-3xl">A steady cycle of practice, review, and tutor guidance</h2>
    <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">Each child practises Mathematics topics their tutor has covered, submits handwritten work, and reviews assigned peer work. Tutors use those activities to see what is understood and guide the next learning steps.</p>
    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      {[
        ['Daily practice', 'Children work through the exercise available for the day and upload their answers.'],
        ['Peer review', 'Students review allocated work using the provided marking guidance.'],
        ['Tutor guidance', 'Tutors review student work, peer marking, and topic understanding.'],
      ].map(([title, description]) => <article key={title} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
        <h3 className="font-semibold text-lime-200">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
      </article>)}
    </div>
  </section>
);

const getDashboardPath = (profile) => {
  if (getPortalForProfile(profile) === 'teacher') return '/teacher';
  return `/${profile.role}`;
};

export const RoleLandingPage = ({ portal }) => {
  const { profile } = useAuth();
  const location = useLocation();
  const config = getPortalConfig(portal);
  const content = portalContent[portal];

  if (!content) return <Navigate to="/" replace />;

  if (profile?.role) {
    const selection = new URLSearchParams(location.search);
    if (selection.has('discountCode') && profile.role === 'student') {
      if (!selection.has('planId')) selection.set('planId', 'circle');
      if (!selection.has('billingPeriod')) selection.set('billingPeriod', 'monthly');
      if (!selection.has('subjectCount')) selection.set('subjectCount', '1');
      return <Navigate to={`/student/billing?${selection.toString()}`} replace />;
    }
    if (selection.has('discountCode') && profile.role === 'parent') {
      return <Navigate to={`/parent?discountCode=${encodeURIComponent(selection.get('discountCode'))}`} replace />;
    }
    return <Navigate to={getDashboardPath(profile)} replace />;
  }

  const loginPath = location.search ? `/login${location.search}` : '/login';
  const signupPath = getSignupPathForPortal(portal, location.search);

  return (
    <main className="relative min-h-[calc(100vh-76px)] overflow-hidden bg-slate-950 px-4 py-14 text-slate-100 sm:py-20 lg:px-6">
      <div className={`pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[52rem] -translate-x-1/2 rounded-full blur-3xl ${portal === 'parent' ? 'bg-[radial-gradient(circle_at_center,rgba(163,230,53,0.2)_0%,rgba(16,185,129,0.12)_42%,transparent_72%)]' : 'bg-[radial-gradient(circle_at_center,rgba(163,230,53,0.16)_0%,rgba(16,185,129,0.08)_42%,transparent_72%)]'}`} />
      <div className="relative mx-auto max-w-7xl">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <section className="max-w-3xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-lime-400/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-lime-300">
              <span className="h-2 w-2 rounded-full bg-lime-400" />
              {content.eyebrow}
            </div>
            <h1 className="text-4xl font-black leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
              {content.description}
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to={loginPath} className="btn-primary gap-2 px-7 py-3.5">
                Sign in to the {config.label.toLowerCase()} portal
                <ArrowRight className="h-4 w-4" />
              </Link>
              {portal !== 'admin' ? (
                <Link
                  to="/papers"
                  className="group inline-flex items-center gap-2 rounded-xl border border-lime-300/30 bg-gradient-to-br from-slate-900/90 via-slate-900/80 to-emerald-950/70 px-6 py-3.5 text-sm font-bold text-lime-100 shadow-[0_10px_30px_rgba(16,185,129,0.12)] transition hover:-translate-y-0.5 hover:border-lime-300/60 hover:bg-lime-400/10 hover:shadow-[0_14px_34px_rgba(16,185,129,0.2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300"
                >
                  <BookOpen className="h-4 w-4 text-lime-300 transition-transform group-hover:-rotate-6" aria-hidden="true" />
                  Browse past papers
                  <ArrowRight className="h-4 w-4 text-emerald-200 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              ) : null}
              {signupPath ? (
                <Link to={signupPath} className="group inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 py-3.5 text-sm font-semibold text-slate-200 backdrop-blur transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/10 hover:text-white">
                  Create a {config.label.toLowerCase()} account
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              ) : (
                <p className="self-center text-sm text-slate-400">Accounts are issued by the Examifying platform owner.</p>
              )}
            </div>
            <div className="mt-9 flex items-center gap-3 text-sm text-slate-400">
              <CheckCircle2 className="h-5 w-5 text-lime-400" />
              <span>One Examifying app, with access controlled by your existing account role.</span>
            </div>
          </section>

          <aside className={`panel relative overflow-hidden p-6 sm:p-8 ${portal === 'parent' ? 'border-lime-300/20 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/80 shadow-[0_24px_80px_rgba(16,185,129,0.12)]' : ''}`}>
            <div className="mb-7 flex items-center justify-between gap-4 border-b border-white/10 pb-6">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-400">{config.audience}</p>
                <h2 className="mt-2 text-xl font-bold text-white">{portal === 'parent' ? 'Your family learning space' : 'Your Examifying portal'}</h2>
              </div>
              <Logo showText={false} className="rounded-2xl border border-lime-400/20 bg-lime-400/5 p-2" />
            </div>
            <div className="space-y-3">
              {content.cards.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex gap-4 rounded-2xl border border-white/5 bg-slate-950/60 p-4">
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-lime-400/10 text-lime-300">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-semibold text-white">{title}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-400">{body}</p>
                  </div>
                </div>
              ))}
            </div>
            {portal === 'admin' ? (
              <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm leading-6 text-amber-100/80">
                Administrator pages remain protected by the signed-in account’s existing role.
              </div>
            ) : null}
          </aside>
        </div>
        {portal === 'parent' ? <>
          <ParentMethodSection />
          <ParentIndicativePricing />
        </> : null}
      </div>
    </main>
  );
};
