import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Play } from 'lucide-react';
import toast from 'react-hot-toast';

interface EnqueueJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEnqueue: (payload: { name: string; payload: any; priority: number }) => Promise<void>;
}

export const EnqueueJobModal: React.FC<EnqueueJobModalProps> = ({ isOpen, onClose, onEnqueue }) => {
  const [name, setName] = useState('manual.job.trigger');
  const [payload, setPayload] = useState('{\n  "data": "example"\n}');
  const [priority, setPriority] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (err) {
      setError('Invalid JSON payload');
      return;
    }

    setIsSubmitting(true);
    try {
      await onEnqueue({ name, payload: parsedPayload, priority });
      toast.success('Job enqueued successfully!');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to enqueue job');
      toast.error('Failed to enqueue job');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="w-full max-w-md bg-background-panel border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="flex justify-between items-center p-5 border-b border-white/10 bg-white/[0.02]">
              <h2 className="text-lg font-semibold text-text-primary">Enqueue a Job</h2>
              <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-text-muted mb-1.5">Job Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-accent-indigo focus:ring-1 focus:ring-accent-indigo transition-all"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-muted mb-1.5">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-accent-indigo focus:ring-1 focus:ring-accent-indigo transition-all"
                >
                  <option value={0} className="bg-background-panel">Normal (0)</option>
                  <option value={1} className="bg-background-panel">High (1)</option>
                  <option value={2} className="bg-background-panel">Critical (2)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-muted mb-1.5">JSON Payload</label>
                <textarea
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  className="w-full h-32 bg-background-main border border-white/10 rounded-md px-3 py-2 text-text-primary text-xs font-mono focus:outline-none focus:border-accent-indigo focus:ring-1 focus:ring-accent-indigo transition-all resize-none"
                  required
                />
              </div>

              {error && <div className="text-accent-red text-sm bg-accent-red/10 p-2 rounded border border-accent-red/20">{error}</div>}

              <div className="flex justify-end gap-3 mt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-text-muted hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center gap-2 px-4 py-2 bg-accent-indigo hover:bg-indigo-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(99,102,241,0.3)]"
                >
                  {isSubmitting ? 'Enqueuing...' : <><Play className="h-4 w-4" /> Enqueue</>}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
