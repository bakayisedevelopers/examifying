import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { StudentNotificationGate } from './StudentNotificationGate';
import { ExamifyingLoader } from './ExamifyingLoader';
import { getPortalForProfile } from '../../utils/portal';

export const ProtectedRoute = ({ allowedRoles }) => {
  const { loading, profile } = useAuth();
  const location = useLocation();

  if (loading) {
    return <ExamifyingLoader />;
  }

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to={`/${profile.role}`} replace />;
  }

  const accountSetupPath = profile.role === ROLES.STUDENT ? '/student/account-setup'
    : getPortalForProfile(profile) === 'teacher' ? '/teacher/account-setup' : '/tutor/account-setup';
  const isAccountSetup = location.pathname === accountSetupPath;
  if (profile.accountSetupStatus === 'required' && !isAccountSetup) {
    return <Navigate to={accountSetupPath} replace />;
  }

  if (profile.role === ROLES.STUDENT) {
    const status = ['unpaid_incomplete', 'paid_incomplete', 'paid_completed'].includes(profile.profileCompletionStatus)
      ? profile.profileCompletionStatus
      : 'unpaid_incomplete';
    const isOnboarding = location.pathname === '/student/onboarding';
    const isBilling = location.pathname === '/student/billing';
    const isPastPapers = location.pathname === '/student/papers' || location.pathname.startsWith('/student/papers/');
    const isProfile = location.pathname === '/student/profile' || location.pathname.startsWith('/student/profile/');

    if (status === 'unpaid_incomplete' && !isOnboarding && !isBilling && !isPastPapers && !isProfile && !isAccountSetup) {
      return <Navigate to="/student/onboarding" replace />;
    }
    if (status === 'paid_incomplete' && !isOnboarding && !isBilling && !isProfile && !isAccountSetup) {
      return <Navigate to="/student/onboarding" replace />;
    }
    if (status === 'paid_completed' && isOnboarding) {
      return <Navigate to="/student" replace />;
    }
  }

  if (profile.role === ROLES.TUTOR || profile.role === 'teacher') {
    const portal = getPortalForProfile(profile);
    const homePath = portal === 'teacher' ? '/teacher' : '/tutor';
    const onboardingPath = `${homePath}/onboarding`;
    const isOnboarding = location.pathname === onboardingPath;
    const isProfile = location.pathname === `${homePath}/profile` || location.pathname.startsWith(`${homePath}/profile/`);
    if (profile.profileCompletionStatus !== 'completed' && !isOnboarding && !isProfile && !isAccountSetup) {
      return <Navigate to={onboardingPath} replace />;
    }
  }

  return (
    <StudentNotificationGate
      profile={profile}
    >
      <Outlet />
    </StudentNotificationGate>
  );
};
