import { Navigate, useLocation } from 'react-router-dom';
import { ProfileSubjectsPage } from '../profile/ProfileSubjectsPage';
import { StudentBillingPage } from '../student/StudentBillingPage';
import { ROLES } from '../../lib/constants';
import { useAuth } from '../../hooks/useAuth';

export const StudentOnboardingPage = () => {
  const { profile } = useAuth();
  const location = useLocation();
  const onboardingNotice = location.state?.paymentVerified
    ? 'Payment verified. Choose at least one subject to finish setting up your account.'
    : '';
  if (profile?.profileCompletionStatus === 'paid_completed') return <Navigate to="/student" replace />;
  if (profile?.profileCompletionStatus === 'paid_incomplete') {
    return <ProfileSubjectsPage role={ROLES.STUDENT} onboarding onboardingNotice={onboardingNotice} />;
  }
  return <StudentBillingPage />;
};
