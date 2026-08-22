export type DestinationStatus = "IDEA" | "RESEARCHING" | "PLANNED" | "BOOKED" | "VISITED" | "ARCHIVED";
export type TripStatus = "DRAFT" | "PLANNING" | "BOOKED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type TripItemType = "TRANSPORT" | "STAY" | "POI" | "ACTIVITY" | "OTHER";
export type BookingStatus = "IDEA" | "RESEARCHING" | "READY_TO_BOOK" | "BOOKED" | "CONFIRMED" | "CANCELLED";
export type BudgetCategory = "TRANSPORT" | "LODGING" | "FOOD" | "ACTIVITIES" | "SHOPPING" | "INSURANCE" | "MISC";
export type TripPlanningType = "SELF_PLANNED" | "GROUP" | "ORGANIZED";
export type TripGoal = "NATURE" | "SIGHTSEEING" | "CITY" | "RELAXATION" | "ADVENTURE" | "MIXED" | "OTHER";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Destination {
  id: string;
  name: string;
  country?: string | null;
  region?: string | null;
  notes?: string | null;
  status: DestinationStatus;
  priority: number;
  tags: string[];
  imageUrl?: string | null;
  roughCostEstimate?: number | null;
  bestSeason?: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { trips: number };
}

export interface BookingAgent {
  id: string;
  name: string;
  type?: string | null;
  contact?: string | null;
  website?: string | null;
  notes?: string | null;
  _count?: { items: number };
}

export interface TripItem {
  id: string;
  tripId: string;
  type: TripItemType;
  title: string;
  provider?: string | null;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
  startAt?: string | null;
  endAt?: string | null;
  cost?: number | null;
  currency?: string | null;
  bookingStatus: BookingStatus;
  confirmationNo?: string | null;
  bookingUrl?: string | null;
  bookingAgentId?: string | null;
  bookingAgent?: BookingAgent | null;
  sortOrder: number;
  notes?: string | null;
}

export interface BudgetLine {
  id: string;
  tripId: string;
  category: BudgetCategory;
  label: string;
  estimated: number;
  actual?: number | null;
  currency: string;
}

export interface Resource {
  id: string;
  title: string;
  url?: string | null;
  category?: string | null;
  notes?: string | null;
  destinationId?: string | null;
  tripId?: string | null;
}

export interface Trip {
  id: string;
  title: string;
  destinationId?: string | null;
  destination?: Destination | null;
  startDate?: string | null;
  endDate?: string | null;
  durationNights?: number | null;
  travelSeason?: string | null;
  planningType?: TripPlanningType | null;
  goal?: TripGoal | null;
  goalDetail?: string | null;
  status: TripStatus;
  travelers: string[];
  notes?: string | null;
  items: TripItem[];
  budgetLines: BudgetLine[];
  resources: Resource[];
  _count?: { items: number };
}

export interface Conflict {
  itemAId: string;
  itemBId: string;
  itemATitle: string;
  itemBTitle: string;
  reason: string;
}

export interface Preferences {
  id: string;
  interests: string[];
  pace?: string | null;
  budgetStyle?: string | null;
  notes?: string | null;
}

export interface ProposedItem {
  day: number;
  type: TripItemType;
  title: string;
  time?: string | null;
  durationHours?: number | null;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
  notes?: string | null;
  estimatedCost?: number | null;
}

export interface ProposedItinerary {
  summary?: string;
  items: ProposedItem[];
}
