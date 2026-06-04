export type Connection = {
  id: string;
  name: string;
  headline: string;
  company: string;
  location: string;
  tags: string[];
  email?: string;
  mutualConnections?: number;
  connectedOn?: string;
};

export const MOCK_CONNECTIONS: Connection[] = [
  { id: "1", name: "Priya Shah", headline: "Sr. Supply Chain Manager", company: "Flipkart", location: "Bangalore", tags: ["supply chain", "logistics", "ops"], mutualConnections: 12, connectedOn: "2024-01-15" },
  { id: "2", name: "Arjun Mehta", headline: "Logistics Lead", company: "Delhivery", location: "Gurgaon", tags: ["supply chain", "last-mile", "logistics"], mutualConnections: 8, connectedOn: "2024-02-03" },
  { id: "3", name: "Neha Verma", headline: "VP Operations & Supply Chain", company: "Zomato", location: "Delhi", tags: ["supply chain", "operations", "vp"], mutualConnections: 5, connectedOn: "2023-12-10" },
  { id: "4", name: "Rohan Iyer", headline: "Procurement Manager", company: "Tata Steel", location: "Mumbai", tags: ["procurement", "supply chain"], email: "rohan.iyer@tatasteel.com", mutualConnections: 3, connectedOn: "2024-01-28" },
  { id: "5", name: "Sara Khan", headline: "Founder & CEO", company: "FreshCart", location: "Pune", tags: ["founder", "d2c", "supply chain", "startup"], mutualConnections: 14, connectedOn: "2024-01-30" },
  { id: "6", name: "Vikram Reddy", headline: "Engineering Manager", company: "Razorpay", location: "Bangalore", tags: ["engineering", "fintech", "manager"], mutualConnections: 20, connectedOn: "2024-03-01" },
  { id: "7", name: "Anita Desai", headline: "Product Designer", company: "Swiggy", location: "Bangalore", tags: ["design", "product", "ux"], mutualConnections: 7, connectedOn: "2024-02-14" },
  { id: "8", name: "Karan Malhotra", headline: "Growth Marketer", company: "CRED", location: "Bangalore", tags: ["growth", "marketing"], mutualConnections: 9, connectedOn: "2024-01-05" },
  { id: "9", name: "Meera Joshi", headline: "Chief Procurement Officer", company: "Infosys", location: "Hyderabad", tags: ["supply chain", "analytics", "procurement", "chief"], email: "meera.joshi@infosys.com", mutualConnections: 11, connectedOn: "2024-03-10" },
  { id: "10", name: "Aditya Nair", headline: "Head of Logistics", company: "Blinkit", location: "Gurgaon", tags: ["logistics", "supply chain", "q-commerce", "head"], mutualConnections: 6, connectedOn: "2023-11-20" },
  { id: "11", name: "Riya Bansal", headline: "Global Logistics Manager", company: "Reliance", location: "Mumbai", tags: ["logistics", "supply chain", "global", "manager"], email: "riya.bansal@reliance.com", mutualConnections: 4, connectedOn: "2024-01-19" },
  { id: "12", name: "Siddharth Patel", headline: "SDE-2", company: "Microsoft", location: "Hyderabad", tags: ["engineering", "technology", "software"], mutualConnections: 18, connectedOn: "2024-02-08" },
  { id: "13", name: "Lakshmi Venkat", headline: "Demand Planning Lead", company: "P&G", location: "Mumbai", tags: ["supply chain", "demand planning", "lead", "fmcg"], email: "lakshmi.venkat@pg.com", mutualConnections: 2, connectedOn: "2024-03-05" },
  { id: "14", name: "Deepak Kumar", headline: "Director of Operations", company: "Maersk", location: "Mumbai", tags: ["operations", "logistics", "supply chain", "director", "shipping"], mutualConnections: 9, connectedOn: "2024-02-22" },
  { id: "15", name: "Nisha Gupta", headline: "ML Engineer", company: "Google", location: "Bangalore", tags: ["machine learning", "ai", "engineering", "tech"], mutualConnections: 22, connectedOn: "2024-02-27" },
  { id: "16", name: "Raj Singhania", headline: "Inventory & Warehouse Lead", company: "BigBasket", location: "Bangalore", tags: ["inventory", "warehouse", "supply chain", "lead"], mutualConnections: 5, connectedOn: "2024-01-10" },
  { id: "17", name: "Pooja Rao", headline: "Supply Chain Analyst", company: "Amazon", location: "Bangalore", tags: ["supply chain", "analytics", "amazon", "ecommerce"], email: "pooja.rao@amazon.com", mutualConnections: 15, connectedOn: "2024-02-18" },
  { id: "18", name: "Manish Tiwari", headline: "Founder", company: "LogiTech Startup", location: "Ahmedabad", tags: ["founder", "logistics", "startup", "tech"], email: "manish@logitech.in", mutualConnections: 1, connectedOn: "2024-03-08" },
  { id: "19", name: "Sunita Krishnan", headline: "Strategic Sourcing Manager", company: "Unilever", location: "Mumbai", tags: ["sourcing", "procurement", "supply chain", "manager", "fmcg"], mutualConnections: 8, connectedOn: "2024-01-25" },
  { id: "20", name: "Amit Sharma", headline: "VP Product", company: "PhonePe", location: "Bangalore", tags: ["product", "fintech", "vp", "payments"], mutualConnections: 13, connectedOn: "2024-02-05" },
];

export const MOCK_INBOX_MESSAGES = [
  {
    id: "m001",
    fromName: "Priya Shah",
    fromHeadline: "Sr. Supply Chain Manager @ Flipkart",
    preview: "Hey! Saw your work on distributed systems. Would love to connect on supply chain tech.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    unread: true,
    thread: [
      { from: "them", text: "Hey! Saw your work on distributed systems. Would love to connect on supply chain tech." },
    ],
  },
  {
    id: "m002",
    fromName: "Vikram Reddy",
    fromHeadline: "Engineering Manager @ Razorpay",
    preview: "Following up — we have a backend opening you might be a great fit for.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    unread: true,
    thread: [
      { from: "them", text: "Hi! We spoke at a meetup last month. We have a backend opening you might be a great fit for. Want to chat?" },
    ],
  },
  {
    id: "m003",
    fromName: "Sara Khan",
    fromHeadline: "Founder & CEO @ FreshCart",
    preview: "Your TON blockchain contest result was impressive — curious if you're exploring web3.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
    unread: false,
    thread: [
      { from: "them", text: "Your TON blockchain contest result was impressive — curious if you're exploring web3 infra for supply chain?" },
      { from: "me", text: "Thanks Sara! Yes, very interested in that space. Would love to discuss." },
      { from: "them", text: "Great. Let's set up a call next week?" },
    ],
  },
  {
    id: "m004",
    fromName: "Deepak Kumar",
    fromHeadline: "Director of Operations @ Maersk",
    preview: "Interesting Swift compiler contribution — are you open to SDE roles?",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 100).toISOString(),
    unread: false,
    thread: [
      { from: "them", text: "Interesting Swift compiler contribution — are you open to SDE roles at Maersk?" },
    ],
  },
];

export const MOCK_CONNECTION_REQUESTS = [
  { id: "r001", fromName: "Rohan Malhotra", fromHeadline: "Supply Chain Consultant @ McKinsey", message: "Hi! I came across your profile and would love to connect.", mutualConnections: 3 },
  { id: "r002", fromName: "Tanvi Shah", fromHeadline: "Operations @ Zomato", message: "", mutualConnections: 7 },
  { id: "r003", fromName: "Kavya Reddy", fromHeadline: "Logistics Head @ BigBasket", message: "Fellow logistics enthusiast here! Let's connect.", mutualConnections: 1 },
];
