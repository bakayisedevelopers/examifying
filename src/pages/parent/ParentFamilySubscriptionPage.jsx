import { Link } from 'react-router-dom';
import { ArrowLeft, Users } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { ParentFamilyPlanBuilder } from '../../components/parent/ParentFamilyPlanBuilder';
import { useAuth } from '../../hooks/useAuth';

export const ParentFamilySubscriptionPage = () => {
  const { profile, logout } = useAuth();

  return (
    <AppShell
      title="Family Subscription"
      subtitle="Choose plans for your children and review the combined family amount."
      role="parent"
      user={profile}
      onLogout={logout}
    >
      <div className="mx-auto max-w-5xl pb-10">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Link to="/parent" className="btn-secondary inline-flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />Family Home
          </Link>
          <Link to="/parent/kids" className="btn-secondary inline-flex items-center gap-2">
            <Users className="h-4 w-4" aria-hidden="true" />Manage kids
          </Link>
        </div>
        <ParentFamilyPlanBuilder />
      </div>
    </AppShell>
  );
};
