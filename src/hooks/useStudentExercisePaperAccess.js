import { useCallback, useEffect, useMemo, useState } from 'react';
import { isExerciseSubmitted } from '../services/exerciseGenerationPlan';
import { getActiveSubjectEpisodesForStudent, subscribeToTodayExercisesForStudent } from '../services/firestoreService';

const paperIdsUsedByExercise = (exercise = {}) => [...new Set([
  ...(Array.isArray(exercise.paperIds) ? exercise.paperIds : []),
  ...(Array.isArray(exercise.questionLinks) ? exercise.questionLinks.map((question) => question?.paperId) : []),
  ...(Array.isArray(exercise.questions) ? exercise.questions.map((question) => question?.paperId) : []),
].map((value) => String(typeof value === 'object' ? value?.id ?? value?.paperId ?? '' : value ?? '').trim()).filter(Boolean))];

export const useStudentExercisePaperAccess = (studentId, enabled = true) => {
  const [state, setState] = useState({ ready: !enabled, error: '', exercises: [] });

  useEffect(() => {
    let active = true;
    let unsubscribeExercises = () => {};

    if (!enabled) {
      setState({ ready: true, error: '', exercises: [] });
      return () => { active = false; };
    }

    setState({ ready: false, error: '', exercises: [] });
    if (!studentId) return () => { active = false; };

    getActiveSubjectEpisodesForStudent(studentId).then((episodes) => {
      if (!active) return;
      if (!episodes.length) {
        setState({ ready: true, error: '', exercises: [] });
        return;
      }
      unsubscribeExercises = subscribeToTodayExercisesForStudent(studentId, episodes, (exercises) => {
        if (active) setState({ ready: true, error: '', exercises });
      }, (error) => {
        if (active) setState({ ready: true, error: error?.message || 'Could not confirm today’s exercise status.', exercises: [] });
      });
    }).catch((error) => {
      if (active) setState({ ready: true, error: error?.message || 'Could not confirm today’s exercise status.', exercises: [] });
    });

    return () => {
      active = false;
      unsubscribeExercises();
    };
  }, [enabled, studentId]);

  const lockedPaperIds = useMemo(() => {
    const ids = new Set();
    state.exercises.filter((exercise) => !isExerciseSubmitted(exercise)).forEach((exercise) => {
      paperIdsUsedByExercise(exercise).forEach((paperId) => ids.add(paperId));
    });
    return ids;
  }, [state.exercises]);

  const isMemoLocked = useCallback((paperId) => (
    enabled && (!state.ready || Boolean(state.error) || lockedPaperIds.has(String(paperId ?? '').trim()))
  ), [enabled, lockedPaperIds, state.error, state.ready]);

  return {
    isLoading: enabled && !state.ready,
    error: enabled ? state.error : '',
    isMemoLocked,
  };
};
