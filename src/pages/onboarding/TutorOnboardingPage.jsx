import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OnboardingCompletionCelebration } from '../../components/common/OnboardingCompletionCelebration';
import { useAuth } from '../../hooks/useAuth';
import { subscribeToUserProfile } from '../../services/firestoreService';
import { getPortalForProfile } from '../../utils/portal';
import { ProfileSubjectsPage } from '../profile/ProfileSubjectsPage';

export const TutorOnboardingPage = ({ role = 'tutor' }) => {
  const { profile, acceptProfileUpdate } = useAuth();
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(profile?.profileCompletionStatus === 'completed');
  const completionHandled = useRef(false);
  const acceptProfileUpdateRef = useRef(acceptProfileUpdate);
  const homePath = getPortalForProfile(profile) === 'teacher' || role === 'teacher' ? '/teacher' : '/tutor';

  useEffect(() => {
    acceptProfileUpdateRef.current = acceptProfileUpdate;
  }, [acceptProfileUpdate]);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    let active = true;
    let navigationTimer;
    const handleProfile = (nextProfile) => {
      if (!active || !nextProfile) return;
      acceptProfileUpdateRef.current(nextProfile);
      if (nextProfile.profileCompletionStatus === 'completed') {
        if (completionHandled.current) return;
        completionHandled.current = true;
        setCompleted(true);
        navigationTimer = window.setTimeout(() => navigate(homePath, { replace: true }), 1800);
      } else {
        completionHandled.current = false;
        setCompleted(false);
      }
    };

    const unsubscribe = subscribeToUserProfile(profile.uid, handleProfile);
    return () => {
      active = false;
      unsubscribe?.();
      if (navigationTimer) window.clearTimeout(navigationTimer);
    };
  }, [homePath, navigate, profile?.uid]);

  return (
    <>
      <ProfileSubjectsPage role={role} onboarding />
      {completed ? <OnboardingCompletionCelebration title="Your profile is complete" message="Your eligible subject is saved. Taking you to your home page…" /> : null}
    </>
  );
};
