import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getParentStudentProfile } from '../services/firestoreService';
import { ExamifyingLoader } from '../components/common/ExamifyingLoader';
import { ParentStudentWorkspaceContext } from './parentStudentWorkspaceStore';

export const ParentStudentWorkspaceProvider = ({ value, children }) => (
  <ParentStudentWorkspaceContext.Provider value={value}>{children}</ParentStudentWorkspaceContext.Provider>
);

export const ParentStudentWorkspaceRoute = () => {
  const { studentId } = useParams();
  const { profile: parentProfile } = useAuth();
  const [studentProfile, setStudentProfile] = useState(null);
  const [loadedStudentId, setLoadedStudentId] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  const refreshStudentProfile = useCallback(async () => {
    const student = await getParentStudentProfile({ parentId: parentProfile?.uid, studentId });
    if (!student) throw new Error('Student profile not found.');
    setStudentProfile(student);
    return student;
  }, [parentProfile?.uid, studentId]);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setError('');
    getParentStudentProfile({ parentId: parentProfile?.uid, studentId }).then((student) => {
      if (!active) return;
      if (!student) throw new Error('Student profile not found.');
      setStudentProfile(student);
      setLoadedStudentId(studentId);
      setStatus('ready');
    }).catch((loadError) => {
      if (!active) return;
      setError(loadError?.message || 'Could not open this student workspace.');
      setStatus('error');
    });
    return () => { active = false; };
  }, [parentProfile?.uid, studentId]);

  const value = useMemo(() => ({
    parentProfile,
    studentProfile,
    loading: status === 'loading',
    error,
    refreshStudentProfile,
  }), [error, parentProfile, refreshStudentProfile, status, studentProfile]);

  if (status === 'error') return <Navigate to="/parent/kids" replace state={{ message: error }} />;
  if (status === 'loading' || loadedStudentId !== studentId) return <ExamifyingLoader />;
  return <ParentStudentWorkspaceProvider value={value}><Outlet /></ParentStudentWorkspaceProvider>;
};
