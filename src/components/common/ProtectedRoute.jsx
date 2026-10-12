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

  if (profile.role === ROLES.STUDENT) {
    const status = ['unpaid_incomplete', 'paid_incomplete', 'paid_completed'].includes(profile.profileCompletionStatus)
      ? profile.profileCompletionStatus
      : 'unpaid_incomplete';
    const isOnboarding = location.pathname === '/student/onboarding';
    const isBilling = location.pathname === '/student/billing';
    const isPastPapers = location.pathname === '/student/papers' || location.pathname.startsWith('/student/papers/');

    if (status === 'unpaid_incomplete' && !isOnboarding && !isBilling && !isPastPapers) {
      return <Navigate to="/student/onboarding" replace />;
    }
    if (status === 'paid_incomplete' && !isOnboarding && !isBilling) {
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
    if (profile.profileCompletionStatus !== 'completed' && !isOnboarding) {
      return <Navigate to={onboardingPath} replace />;
    }
  }

  return (
    <StudentNotificationGate profile={profile} required={profile.role === ROLES.STUDENT && allowedRoles?.includes(ROLES.STUDENT)}>
      <Outlet />
    </StudentNotificationGate>
  );
};
