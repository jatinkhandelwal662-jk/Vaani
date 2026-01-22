
export interface ComplaintData {
  fullName: string;
  mobileNumber: string;
  complaintType: string;
  description: string;
  location: string;
  duration: string;
  complaintId: string | null;
}

export interface TranscriptionItem {
  role: 'user' | 'officer';
  text: string;
  timestamp: number;
}