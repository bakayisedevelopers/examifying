import { useEffect, useRef, useState } from 'react';
import { subscribePeerMarkingAssignmentsForStudent } from '../../services/firestoreService';
import { getNotificationSupportState, registerStudentNotificationDevice } from '../../services/notificationService';
import { useOperationStatus } from '../../hooks/useOperationStatus';

const getNotificationPermission = () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

const isAiStudioPreview = () => {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname || '';
  const isAiStudioHost = /^ais-(?:dev|pre)-.*\.run\.app$/i.test(hostname) || /aistudio/i.test(hostname);
  const hasAiStudioAncestor = Boolean(
    window.location.ancestorOrigins &&
      Array.from(window.location.ancestorOrigins).some((origin) => /aistudio\.google\.com/i.test(origin))
  );
  const hasAiStudioReferrer = typeof document !== 'undefined' && /aistudio\.google\.com/i.test(document.referrer || '');
  return isAiStudioHost || hasAiStudioAncestor || hasAiStudioReferrer;
};

const getNotificationEnvironment = () => {
  if (typeof navigator === 'undefined') return { ios: false, android: false, windows: false, safari: false, installed: false, aiStudio: false };
  const userAgent = navigator.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
  const installed = Boolean(navigator.standalone) || window.matchMedia?.('(display-mode: standalone)').matches === true;
  const windows = /Windows/i.test(userAgent) || /Win/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
  const aiStudio = isAiStudioPreview();
  return { ios, android: /Android/i.test(userAgent), windows, safari, installed, aiStudio };
};

const getSettingsGuidance = () => {
  const { ios, android, safari, installed } = getNotificationEnvironment();
  if (ios && safari && !installed) {
    return 'On iPhone or iPad, web notifications work from the installed web app. In Safari, tap Share, choose Add to Home Screen, open Examifying from its new Home Screen icon, then tap Enable notifications.';
  }
  if (ios && installed) {
    return 'Open iPhone or iPad Settings, find Examifying under Notifications (or Settings > Notifications), and allow notifications. Return to the installed Examifying app and tap Check notification access.';
  }
  if (android) {
    return 'In Chrome, open Examifying site settings and set Notifications to Allow. Also check Android Settings > Apps > Chrome > Notifications. Return here and tap Check notification access.';
  }
  return 'Open this site’s permissions from your browser’s address bar or site settings and allow notifications. Return here and tap Check notification access.';
};

const buildAssignmentText = (assignment) => {
  const subject = assignment.subject ? `${assignment.subject} ` : '';
  const title = assignment.title || 'exercise';
  return `${subject}${title}`.trim();
};

const getDismissalKey = (uid) => `examifying-notifications-dismissed:${uid || 'account'}`;

export const StudentNotificationGate = ({ profile, children }) => {
  const { runOperation } = useOperationStatus();
  const { aiStudio } = getNotificationEnvironment();
  const [permission, setPermission] = useState(getNotificationPermission);
  const [error, setError] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [deviceRegistered, setDeviceRegistered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const initializedRef = useRef(false);
  const seenAssignmentsRef = useRef(new Set());

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(getDismissalKey(profile?.uid)) === 'yes');
    } catch {
      setDismissed(false);
    }
  }, [profile?.uid]);

  useEffect(() => {
    const refreshPermission = () => setPermission(getNotificationPermission());
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, []);

  useEffect(() => {
    if (profile?.role !== 'student' || !profile?.uid || permission !== 'granted' || !deviceRegistered) return undefined;

    return subscribePeerMarkingAssignmentsForStudent(profile.uid, (assignments) => {
      const openAssignments = assignments.filter((assignment) => assignment.status !== 'completed');

      if (!initializedRef.current) {
        openAssignments.forEach((assignment) => seenAssignmentsRef.current.add(assignment.id));
        initializedRef.current = true;
        return;
      }

      openAssignments.forEach((assignment) => {
        if (seenAssignmentsRef.current.has(assignment.id)) return;
        seenAssignmentsRef.current.add(assignment.id);

        const notification = new Notification('New work to mark', {
          body: `${buildAssignmentText(assignment)} is ready for peer marking.`,
          icon: '/logo.png',
          tag: `peer-marking-${assignment.id}`,
        });
        notification.onclick = () => {
          window.focus();
          window.location.href = '/student?tab=mark';
          notification.close();
        };
      });
    });
  }, [deviceRegistered, permission, profile?.role, profile?.uid]);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(getDismissalKey(profile?.uid), 'yes');
    } catch {
      // Access to the app remains available even when browser storage is disabled.
    }
  };

  const requestPermission = async () => {
    setError('');
    setDeviceRegistered(false);
    if (getNotificationPermission() === 'unsupported') {
      setPermission('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPermission('denied');
      setError(getSettingsGuidance());
      return;
    }

    setIsRegistering(true);
    try {
      // Keep the permission prompt directly inside the user's tap gesture.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setError(getSettingsGuidance());
        return;
      }

      const support = await getNotificationSupportState();
      if (!support.supported) {
        throw new Error('Permission is enabled, but this browser cannot register push notifications with the current notification service.');
      }
      await runOperation({ operationName: 'Registering this device for notifications', successMessage: 'This device is registered for notifications.' }, () => registerStudentNotificationDevice(profile.uid));
      setDeviceRegistered(true);
    } catch (requestError) {
      setDeviceRegistered(false);
      setError(requestError?.message ?? 'Could not request notification permission.');
    } finally {
      setIsRegistering(false);
    }
  };

  const checkNotificationAccess = async () => {
    const currentPermission = getNotificationPermission();
    setPermission(currentPermission);
    setError('');
    if (currentPermission !== 'granted') {
      setError(getSettingsGuidance());
      return;
    }
    if (!profile?.uid) return;
    setIsRegistering(true);
    try {
      const support = await getNotificationSupportState();
      if (!support.supported) {
        throw new Error('Permission is enabled, but this browser cannot register push notifications with the current notification service.');
      }
      await runOperation({ operationName: 'Checking notification access', successMessage: 'Notification access is ready.' }, () => registerStudentNotificationDevice(profile.uid));
      setDeviceRegistered(true);
    } catch (checkError) {
      setError(checkError?.message ?? 'Could not register this browser for notifications.');
    } finally {
      setIsRegistering(false);
    }
  };

  useEffect(() => {
    if (permission !== 'granted' || !profile?.uid || deviceRegistered || isRegistering) return;
    registerStudentNotificationDevice(profile.uid)
      .then(() => setDeviceRegistered(true))
      .catch((registrationError) => {
        setDeviceRegistered(false);
        setError(registrationError?.message ?? 'Could not register this browser for notifications.');
      });
  }, [deviceRegistered, isRegistering, permission, profile?.uid]);

  if (aiStudio) return children;

  // Notification permission is optional. The protected page stays available while a user
  // decides whether this browser should receive push notifications.
  if (permission === 'granted' || dismissed) return children;

  const prompt = permission === 'unsupported'
    ? 'Notifications are not supported by this browser. You can continue using Examifying.'
    : 'Enable browser notifications to receive Examifying alerts on this device. You can continue without enabling them.';
  const primaryAction = permission === 'denied' ? checkNotificationAccess : requestPermission;

  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-4 lg:px-6">
        <div className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-slate-600">
          <div className="min-w-0 flex-1">
            <p>{prompt}</p>
            {permission === 'denied' ? <p className="mt-1 text-xs text-slate-500">{getSettingsGuidance()}</p> : null}
            {error ? <p className="mt-1 text-xs font-medium text-rose-700">{error}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={primaryAction} disabled={isRegistering || permission === 'unsupported'}>
              {isRegistering ? 'Enabling…' : permission === 'denied' ? 'Check notification access' : 'Enable notifications'}
            </button>
            <button type="button" className="btn-secondary" onClick={dismiss}>
              No thanks
            </button>
          </div>
        </div>
      </div>
      {children}
    </>
  );
};
