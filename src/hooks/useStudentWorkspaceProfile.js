import { useCallback, useContext } from 'react';
import { useAuth } from './useAuth';
import { ParentStudentWorkspaceContext } from '../contexts/parentStudentWorkspaceStore';

export const useParentStudentWorkspace = () => useContext(ParentStudentWorkspaceContext);

export const useStudentWorkspaceProfile = () => {
  const auth = useAuth();
  const refreshAuthProfile = auth.refreshProfile;
  const workspace = useParentStudentWorkspace();
  const profile = workspace?.studentProfile ?? auth.profile;
  const refreshViewedProfile = useCallback(async (uid = profile?.uid) => {
    if (workspace) return workspace.refreshStudentProfile();
    return refreshAuthProfile(uid);
  }, [profile?.uid, refreshAuthProfile, workspace]);
  const toStudentPath = useCallback((studentPath) => {
    if (!workspace?.studentProfile?.uid) {
      return studentPath === '/student/subscription' ? '/student/billing' : studentPath;
    }
    const suffix = String(studentPath ?? '').replace(/^\/student(?=\/|$)/, '');
    return `/parent/kids/${workspace.studentProfile.uid}${suffix}`;
  }, [workspace?.studentProfile?.uid]);
  return {
    ...auth,
    profile,
    isParentWorkspace: Boolean(workspace),
    parentProfile: workspace?.parentProfile ?? null,
    refreshViewedProfile,
    toStudentPath,
  };
};
