import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, isFirebaseConfigured } from '../firebase/config';
import {
  getUserProfile,
  completeAccountSetup as saveAccountSetup,
  completeManagedStudentInvite as redeemStudentInvite,
  loginWithEmail,
  logout,
  registerWithGoogle as createGoogleAccount,
  registerWithEmail,
  signInWithGoogle,
  updateStudentOnboarding,
} from '../services/authService';
import { mockUsers } from '../data/mockData';
import { getCachedStudentSubscriptionState, loadStudentSubscriptionState, setStudentSubscriptionState } from '../services/studentSubscriptionStateStore';
import { reconcileProfileCompletion, updateProfileCompletionStatus } from '../services/profileOnboardingService';
import { queryClient } from '../lib/queryClient';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [state, setState] = useState({ user: null, profile: null, loading: true, error: null });
  const lastAuthUid = useRef(null);

  const resolveOnboardingProfile = async (profile) => {
    if (!profile) return null;
    try {
      const resolved = await reconcileProfileCompletion(profile);
      if (resolved.subscriptionState) setStudentSubscriptionState(profile.uid, resolved.subscriptionState);
      return resolved.profile;
    } catch (error) {
      const fallbackStatus = profile.role === 'student'
        ? 'unpaid_incomplete'
        : ['tutor', 'teacher'].includes(profile.role) ? 'incomplete' : profile.profileCompletionStatus;
      return {
        ...profile,
        ...(fallbackStatus ? { profileCompletionStatus: fallbackStatus } : {}),
        onboardingStatusCheckFailed: true,
        onboardingStatusCheckError: error?.message || 'We could not verify profile completion. Please retry.',
      };
    }
  };

  const refreshProfile = async (uid, userOverride = null) => {
    const profile = await getUserProfile(uid);
    setState((current) => ({ ...current, user: userOverride ?? current.user, profile, loading: false, error: null }));
    return profile;
  };

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setState({ user: null, profile: null, loading: false, error: null });
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const nextUid = firebaseUser?.uid ?? null;
      if (lastAuthUid.current !== nextUid) queryClient.clear();
      lastAuthUid.current = nextUid;

      if (!firebaseUser) {
        setState({ user: null, profile: null, loading: false, error: null });
        return;
      }

      try {
        const profile = await getUserProfile(firebaseUser.uid);
        const resolvedProfile = await resolveOnboardingProfile(profile);
        setState((current) => {
          if (!resolvedProfile && current.user?.uid === firebaseUser.uid && current.profile?.uid === firebaseUser.uid) {
            return { ...current, loading: false, error: null };
          }
          return { user: firebaseUser, profile: resolvedProfile, loading: false, error: null };
        });
        if (resolvedProfile?.role === 'student' && !getCachedStudentSubscriptionState(resolvedProfile.uid)) {
          void loadStudentSubscriptionState(resolvedProfile, { maxAgeMs: 30_000 });
        }
      } catch (error) {
        setState({ user: firebaseUser, profile: null, loading: false, error: error?.message || 'Could not load your account.' });
      }
    });

    return unsubscribe;
  }, []);

  const value = useMemo(() => ({
    ...state,
    isDemoMode: !isFirebaseConfigured,
    refreshProfile,
    login: async (payload) => {
      const result = await loginWithEmail(payload);
      queryClient.clear();
      const resolvedProfile = await resolveOnboardingProfile(result.profile);
      setState({ user: result.user, profile: resolvedProfile, loading: false, error: null });
      return { ...result, profile: resolvedProfile };
    },
    register: async (payload) => {
      const result = await registerWithEmail(payload);
      queryClient.clear();
      const resolvedProfile = await resolveOnboardingProfile(result.profile);
      setState({ user: result.user, profile: resolvedProfile, loading: false, error: null });
      return { ...result, profile: resolvedProfile };
    },
    registerWithGoogle: async (payload) => {
      const result = await createGoogleAccount(payload);
      queryClient.clear();
      const resolvedProfile = await resolveOnboardingProfile(result.profile);
      setState({ user: result.user, profile: resolvedProfile, loading: false, error: null });
      return { ...result, profile: resolvedProfile };
    },
    completeManagedStudentInvite: async (payload) => {
      const result = await redeemStudentInvite(payload);
      queryClient.clear();
      const resolvedProfile = await resolveOnboardingProfile(result.profile);
      setState({ user: result.user, profile: resolvedProfile, loading: false, error: null });
      return { ...result, profile: resolvedProfile };
    },
    completeAccountSetup: async (payload) => {
      const result = await saveAccountSetup(payload);
      const profile = await getUserProfile(result.uid);
      const resolvedProfile = await resolveOnboardingProfile(profile);
      setState((current) => ({ ...current, profile: resolvedProfile, loading: false, error: null }));
      return resolvedProfile;
    },
    updateStudentOnboarding: async (payload) => {
      const updated = await updateStudentOnboarding(payload);
      setState((current) => ({
        ...current,
        profile: { ...current.profile, ...updated },
      }));
      return updated;
    },
    setProfileCompletionStatus: async (status) => {
      const uid = state.profile?.uid;
      if (!uid) throw new Error('Your account profile is not available.');
      const updated = await updateProfileCompletionStatus({ uid, status });
      setState((current) => ({
        ...current,
        profile: { ...current.profile, ...updated, onboardingStatusCheckFailed: false, onboardingStatusCheckError: '' },
      }));
      return updated;
    },
    acceptProfileUpdate: (profile) => {
      if (!profile) return;
      setState((current) => {
        if (current.profile?.uid !== profile.uid
          || current.profile.profileCompletionStatus === profile.profileCompletionStatus) return current;
        return { ...current, profile: { ...current.profile, profileCompletionStatus: profile.profileCompletionStatus } };
      });
    },
    retryProfileCompletionCheck: async () => {
      if (!state.profile) return null;
      const resolved = await resolveOnboardingProfile(state.profile);
      setState((current) => ({ ...current, profile: resolved, error: null }));
      return resolved;
    },
    loginAsDemo: async (email) => {
      const mockUser = mockUsers[email];
      if (!mockUser) throw new Error('Unknown demo account');
      queryClient.clear();
      const resolvedProfile = await resolveOnboardingProfile(mockUser);
      setState({ user: mockUser, profile: resolvedProfile, loading: false, error: null });
      return resolvedProfile;
    },
    loginWithGoogle: async () => {
      const result = await signInWithGoogle();
      queryClient.clear();
      const resolvedProfile = await resolveOnboardingProfile(result.profile);
      setState({ user: result.user, profile: resolvedProfile, loading: false, error: null });
      return { ...result, profile: resolvedProfile };
    },
    logout: async () => {
      await logout();
      queryClient.clear();
      setState({ user: null, profile: null, loading: false, error: null });
    },
  }), [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
