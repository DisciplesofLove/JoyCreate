/**
 * Decentralized Meeting Service
 * Integrates WebRTC with the decentralized chat for video calls
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import { signSignal, verifySignal } from "@/lib/webrtc_signing";
import { webRTCClient } from "@/ipc/webrtc_client";
import type {
  Meeting,
  MeetingParticipant,
  MeetingSettings,
  MeetingType,
  CreateMeetingRequest,
  JoinMeetingRequest,
  ChatIdentity,
} from "@/types/decentralized_chat_types";
import type {
  WebRTCSignal,
  WebRTCStats,
  MediaDeviceInfo,
  SignalingMessageType,
} from "@/types/webrtc_types";

// ============================================================================
// Internal Signal Type (simplified for local use)
// ============================================================================

interface InternalSignal {
  type: SignalingMessageType;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  from: string;
  to: string;
}

// Helper to create full signaling messages.
//
// Returns an unsigned message; callers MUST pass the result through
// `signSignal()` (from `@/lib/webrtc_signing`) before transmitting,
// and the receive path MUST run `verifySignal()` before acting on
// the contents. We keep these as separate steps so callers that
// don't need authentication (e.g. local-only echo) aren't forced
// into an async signature flow.
function createSignalingMessage(signal: InternalSignal): WebRTCSignal {
  return {
    id: crypto.randomUUID(),
    type: signal.type,
    from: signal.from,
    fromWallet: signal.from,
    to: signal.to,
    toWallet: signal.to,
    sdp: signal.sdp,
    candidate: signal.candidate ? {
      candidate: signal.candidate.candidate || "",
      sdpMid: signal.candidate.sdpMid || null,
      sdpMLineIndex: signal.candidate.sdpMLineIndex ?? null,
    } : undefined,
    signature: "", // populated by signSignal()
    timestamp: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
}

/**
 * Build, sign, and emit a signaling message in one call. Logs and
 * swallows signing errors so a missing wallet can never crash the
 * meeting service — but the receive side will reject the unsigned
 * message, so the user sees the failure as "peer can't connect"
 * rather than a thrown promise.
 */
async function emitSignedSignal(
  internal: InternalSignal,
  emit: ((s: WebRTCSignal) => void) | undefined,
): Promise<void> {
  if (!emit) return;
  const base = createSignalingMessage(internal);
  try {
    const signed = await signSignal(base);
    emit(signed);
  } catch (err) {
    console.error("[meeting] failed to sign signaling message", err);
    // Do NOT emit the unsigned base — that would let an attacker
    // observe the failure mode and inject a forged signature.
  }
}

// ============================================================================
// Meeting Service Hook
// ============================================================================

interface UseMeetingServiceOptions {
  identity: ChatIdentity | null;
  onParticipantJoined?: (participant: MeetingParticipant) => void;
  onParticipantLeft?: (walletAddress: string) => void;
  onSignal?: (signal: WebRTCSignal) => void;
}

export function useMeetingService({
  identity,
  onParticipantJoined,
  onParticipantLeft,
  onSignal,
}: UseMeetingServiceOptions) {
  const queryClient = useQueryClient();
  const ipcClient = IpcClient.getInstance();

  // Local state
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Media state
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);

  // Refs for peer connections
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannels = useRef<Map<string, RTCDataChannel>>(new Map());

  // Create a new meeting
  const createMeeting = useMutation({
    mutationFn: async (request: CreateMeetingRequest) => {
      if (!identity) throw new Error("No identity");

      const defaultSettings: MeetingSettings = {
        startWithAudioMuted: false,
        startWithVideoOff: false,
        allowParticipantVideo: true,
        allowParticipantAudio: true,
        allowScreenShare: true,
        muteOnEntry: false,
        lockMeeting: false,
        allowChat: true,
        allowReactions: true,
        allowHandRaise: true,
        allowRecording: true,
        notifyOnRecording: true,
        endToEndEncryption: true,
        enableWaitingRoom: false,
        autoAdmit: true,
        defaultLayout: "gallery",
        maxVideoTiles: 25,
        preferredVideoQuality: "auto",
        preferredAudioCodec: "opus",
      };

      const meeting: Meeting = {
        id: crypto.randomUUID(),
        conversationId: request.conversationId || "",
        title: request.title,
        description: request.description,
        type: request.type,
        status: request.type === "instant" ? "live" : "scheduled",
        hostWallet: identity.walletAddress,
        scheduledStart: request.scheduledStart,
        scheduledEnd: request.scheduledEnd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        participants: [],
        maxParticipants: 50,
        waitingRoom: [],
        isPublic: false,
        requiresApproval: false,
        isRecording: false,
        allowRecording: true,
        autoRecord: false,
        webrtcRoomId: crypto.randomUUID(),
        signalingTopic: `meeting-${crypto.randomUUID()}`,
        settings: { ...defaultSettings, ...request.settings },
      };

      // Publish meeting to the network via IPC
      // await ipcClient.createMeeting(meeting);

      return meeting;
    },
    onSuccess: (meeting) => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      if (meeting.type === "instant") {
        setActiveMeeting(meeting);
      }
    },
  });

  // Join an existing meeting
  const joinMeeting = useMutation({
    mutationFn: async (request: JoinMeetingRequest) => {
      if (!identity) throw new Error("No identity");
      setIsConnecting(true);
      setError(null);

      try {
        // Get user media
        const stream = await navigator.mediaDevices.getUserMedia({
          video: request.videoEnabled !== false,
          audio: request.audioEnabled !== false,
        });
        setLocalStream(stream);
        setVideoEnabled(request.videoEnabled !== false);
        setAudioEnabled(request.audioEnabled !== false);

        // Create local participant
        const localParticipant: MeetingParticipant = {
          walletAddress: identity.walletAddress,
          displayName: identity.displayName,
          role: request.meetingId === activeMeeting?.id && activeMeeting?.hostWallet === identity.walletAddress
            ? "host"
            : "participant",
          joinedAt: new Date().toISOString(),
          audioEnabled: request.audioEnabled !== false,
          videoEnabled: request.videoEnabled !== false,
          screenSharing: false,
          handRaised: false,
          status: "connecting",
        };

        setParticipants([localParticipant]);

        // Signal joining to other participants via IPC/libp2p
        // await ipcClient.joinMeeting(request.meetingId, identity.walletAddress);

        return { success: true, participant: localParticipant };
      } catch (err) {
        setError((err as Error).message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
  });

  // Leave the current meeting
  const leaveMeeting = useCallback(async () => {
    // Stop local tracks
    localStream?.getTracks().forEach(track => track.stop());
    setLocalStream(null);

    // Close all peer connections
    peerConnections.current.forEach(pc => pc.close());
    peerConnections.current.clear();
    dataChannels.current.clear();
    setRemoteStreams(new Map());

    // Clear state
    setActiveMeeting(null);
    setParticipants([]);
    setScreenSharing(false);

    // Signal leaving to other participants
    // await ipcClient.leaveMeeting(meetingId, identity?.walletAddress);
  }, [localStream, identity]);

  // Toggle audio
  const toggleAudio = useCallback(() => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setAudioEnabled(audioTrack.enabled);

        // Update local participant
        setParticipants(prev => prev.map(p =>
          p.walletAddress === identity?.walletAddress
            ? { ...p, audioEnabled: audioTrack.enabled }
            : p
        ));

        // Signal audio state change to others
        // broadcastMediaState({ audio: audioTrack.enabled });
      }
    }
  }, [localStream, identity]);

  // Toggle video
  const toggleVideo = useCallback(() => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setVideoEnabled(videoTrack.enabled);

        // Update local participant
        setParticipants(prev => prev.map(p =>
          p.walletAddress === identity?.walletAddress
            ? { ...p, videoEnabled: videoTrack.enabled }
            : p
        ));

        // Signal video state change to others
        // broadcastMediaState({ video: videoTrack.enabled });
      }
    }
  }, [localStream, identity]);

  // Toggle screen sharing
  const toggleScreenShare = useCallback(async () => {
    if (screenSharing) {
      // Stop screen sharing
      localStream?.getVideoTracks().forEach(track => {
        if (track.label.includes("screen")) {
          track.stop();
        }
      });
      setScreenSharing(false);

      // Re-enable camera
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = stream.getVideoTracks()[0];
        if (localStream && videoTrack) {
          const sender = peerConnections.current.values().next().value
            ?.getSenders()
            .find((s: RTCRtpSender) => s.track?.kind === "video");
          if (sender) {
            await sender.replaceTrack(videoTrack);
          }
        }
      } catch (err) {
        console.error("Failed to re-enable camera:", err);
      }
    } else {
      // Start screen sharing
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        const screenTrack = stream.getVideoTracks()[0];

        // Replace video track in all peer connections
        peerConnections.current.forEach(async pc => {
          const sender = pc.getSenders().find(s => s.track?.kind === "video");
          if (sender) {
            await sender.replaceTrack(screenTrack);
          }
        });

        screenTrack.onended = () => {
          setScreenSharing(false);
          // Re-enable camera when screen share stops
          toggleScreenShare();
        };

        setScreenSharing(true);

        // Update local participant
        setParticipants(prev => prev.map(p =>
          p.walletAddress === identity?.walletAddress
            ? { ...p, screenSharing: true }
            : p
        ));
      } catch (err) {
        console.error("Failed to start screen sharing:", err);
      }
    }
  }, [screenSharing, localStream, identity]);

  // Toggle hand raised
  const toggleHand = useCallback(() => {
    setParticipants(prev => prev.map(p =>
      p.walletAddress === identity?.walletAddress
        ? { ...p, handRaised: !p.handRaised }
        : p
    ));
    // Signal hand state to others
    // broadcastHandState(!currentHandState);
  }, [identity]);

  // Create peer connection for a participant.
  //
  // ICE servers come from the decentralized pool managed by
  // `webrtc_handlers.ts` / `decentralized_ice.ts` (Cloudflare /
  // Nextcloud / community STUN + any peer-operated TURN nodes).
  // Falls back to a single Cloudflare entry if the IPC call fails
  // so the call can still establish on a public IP.
  const createPeerConnection = useCallback(async (
    participantWallet: string,
    isInitiator: boolean
  ) => {
    let iceServers: RTCIceServer[];
    try {
      iceServers = await webRTCClient.getDecentralizedIceServers();
      if (!iceServers.length) throw new Error("empty pool");
    } catch (err) {
      console.warn("[meeting] decentralized ICE unavailable, using cloudflare fallback", err);
      iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }];
    }
    const pc = new RTCPeerConnection({ iceServers });

    peerConnections.current.set(participantWallet, pc);

    // Add local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Handle incoming tracks
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      setRemoteStreams(prev => new Map(prev).set(participantWallet, stream));
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void emitSignedSignal({
          type: "ice-candidate",
          candidate: event.candidate.toJSON(),
          from: identity?.walletAddress || "",
          to: participantWallet,
        }, onSignal);
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      setParticipants(prev => prev.map(p =>
        p.walletAddress === participantWallet
          ? { ...p, status: mapConnectionState(pc.connectionState) }
          : p
      ));
    };

    // Create data channel for signaling
    if (isInitiator) {
      const channel = pc.createDataChannel("signaling");
      dataChannels.current.set(participantWallet, channel);
      channel.onmessage = handleDataChannelMessage;
    } else {
      pc.ondatachannel = (event) => {
        dataChannels.current.set(participantWallet, event.channel);
        event.channel.onmessage = handleDataChannelMessage;
      };
    }

    // Create offer if initiator
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await emitSignedSignal({
        type: "offer",
        sdp: offer.sdp,
        from: identity?.walletAddress || "",
        to: participantWallet,
      }, onSignal);
    }

    return pc;
  }, [localStream, identity, onSignal]);

  // Handle incoming WebRTC signals.
  //
  // Every inbound signal MUST pass `verifySignal()` before it touches
  // RTCPeerConnection — otherwise an attacker on the chat transport
  // can spoof offers / candidates and either MITM the call or DoS by
  // pumping bogus candidates.
  const handleSignal = useCallback(async (signal: WebRTCSignal) => {
    const v = verifySignal(signal);
    if (!v.ok) {
      console.warn(
        `[meeting] dropping unverified signal from ${signal.fromWallet}: ${v.reason}`,
      );
      return;
    }
    const pc = peerConnections.current.get(signal.from) ||
      await createPeerConnection(signal.from, false);

    switch (signal.type) {
      case "offer":
        await pc.setRemoteDescription(new RTCSessionDescription({
          type: "offer",
          sdp: signal.sdp,
        }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await emitSignedSignal({
          type: "answer",
          sdp: answer.sdp,
          from: identity?.walletAddress || "",
          to: signal.from,
        }, onSignal);
        break;

      case "answer":
        await pc.setRemoteDescription(new RTCSessionDescription({
          type: "answer",
          sdp: signal.sdp,
        }));
        break;

      case "ice-candidate":
        if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
        break;
    }
  }, [createPeerConnection, identity, onSignal]);

  // Handle data channel messages
  const handleDataChannelMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      // Handle participant state updates, chat messages, etc.
      console.log("Data channel message:", data);
    } catch (err) {
      console.error("Failed to parse data channel message:", err);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      localStream?.getTracks().forEach(track => track.stop());
      peerConnections.current.forEach(pc => pc.close());
    };
  }, [localStream]);

  return {
    // State
    activeMeeting,
    participants,
    localStream,
    remoteStreams,
    isConnecting,
    error,
    audioEnabled,
    videoEnabled,
    screenSharing,

    // Actions
    createMeeting: createMeeting.mutateAsync,
    joinMeeting: joinMeeting.mutateAsync,
    leaveMeeting,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
    toggleHand,
    handleSignal,

    // Loading states
    isCreating: createMeeting.isPending,
    isJoining: joinMeeting.isPending,
  };
}

// Helper function to map RTCPeerConnectionState to our status type
function mapConnectionState(state: RTCPeerConnectionState): MeetingParticipant["status"] {
  switch (state) {
    case "new":
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "disconnected":
    case "failed":
    case "closed":
      return "disconnected";
    default:
      return "connecting";
  }
}

// ============================================================================
// Media Devices Hook
// ============================================================================

export function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInput, setSelectedAudioInput] = useState<string>("");
  const [selectedVideoInput, setSelectedVideoInput] = useState<string>("");
  const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>("");

  // Enumerate devices
  const refreshDevices = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      setDevices(allDevices as MediaDeviceInfo[]);

      // Set defaults if not already set
      if (!selectedAudioInput) {
        const defaultAudio = allDevices.find(d => d.kind === "audioinput");
        if (defaultAudio) setSelectedAudioInput(defaultAudio.deviceId);
      }
      if (!selectedVideoInput) {
        const defaultVideo = allDevices.find(d => d.kind === "videoinput");
        if (defaultVideo) setSelectedVideoInput(defaultVideo.deviceId);
      }
      if (!selectedAudioOutput) {
        const defaultOutput = allDevices.find(d => d.kind === "audiooutput");
        if (defaultOutput) setSelectedAudioOutput(defaultOutput.deviceId);
      }
    } catch (err) {
      console.error("Failed to enumerate devices:", err);
    }
  }, [selectedAudioInput, selectedVideoInput, selectedAudioOutput]);

  // Listen for device changes
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  const audioInputDevices = devices.filter(d => d.kind === "audioinput");
  const videoInputDevices = devices.filter(d => d.kind === "videoinput");
  const audioOutputDevices = devices.filter(d => d.kind === "audiooutput");

  return {
    devices,
    audioInputDevices,
    videoInputDevices,
    audioOutputDevices,
    selectedAudioInput,
    selectedVideoInput,
    selectedAudioOutput,
    setSelectedAudioInput,
    setSelectedVideoInput,
    setSelectedAudioOutput,
    refreshDevices,
  };
}

// ============================================================================
// Connection Quality Hook
// ============================================================================

export function useConnectionQuality(peerConnection: RTCPeerConnection | null) {
  const [quality, setQuality] = useState<"excellent" | "good" | "fair" | "poor">("good");
  const [stats, setStats] = useState<WebRTCStats | null>(null);

  useEffect(() => {
    if (!peerConnection) return;

    const interval = setInterval(async () => {
      try {
        const report = await peerConnection.getStats();
        let packetsLost = 0;
        let packetsReceived = 0;
        let roundTripTime = 0;

        report.forEach(stat => {
          if (stat.type === "inbound-rtp") {
            packetsLost += stat.packetsLost || 0;
            packetsReceived += stat.packetsReceived || 0;
          }
          if (stat.type === "candidate-pair" && stat.state === "succeeded") {
            roundTripTime = stat.currentRoundTripTime || 0;
          }
        });

        const lossRate = packetsReceived > 0 ? packetsLost / packetsReceived : 0;

        // Determine quality based on packet loss and RTT
        if (lossRate < 0.01 && roundTripTime < 0.1) {
          setQuality("excellent");
        } else if (lossRate < 0.05 && roundTripTime < 0.2) {
          setQuality("good");
        } else if (lossRate < 0.1 && roundTripTime < 0.5) {
          setQuality("fair");
        } else {
          setQuality("poor");
        }

        setStats({
          timestamp: Date.now(),
          connectionState: peerConnection.connectionState as any,
          roundTripTime,
          jitter: 0,
          packetLoss: lossRate,
          audioBytesSent: 0,
          audioBytesReceived: 0,
          audioPacketsSent: 0,
          audioPacketsReceived: packetsReceived,
          audioLevel: 0,
          videoBytesSent: 0,
          videoBytesReceived: 0,
          videoPacketsSent: 0,
          videoPacketsReceived: 0,
          frameWidth: 0,
          frameHeight: 0,
          framesPerSecond: 0,
          framesDropped: 0,
          availableOutgoingBitrate: 0,
          availableIncomingBitrate: 0,
        });
      } catch (err) {
        console.error("Failed to get stats:", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [peerConnection]);

  return { quality, stats };
}

export default useMeetingService;
