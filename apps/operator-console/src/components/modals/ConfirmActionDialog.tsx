import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';

interface ConfirmActionDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  isDestructive?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export const ConfirmActionDialog: React.FC<ConfirmActionDialogProps> = ({ 
  isOpen, title, message, confirmText = 'Confirm', isDestructive = false, onClose, onConfirm 
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-sm bg-[#1A1D27] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="p-6">
              <div className="flex items-center gap-3 mb-3">
                {isDestructive && <div className="p-2 bg-status-failed/10 text-status-failed rounded-full"><AlertTriangle className="h-5 w-5" /></div>}
                <h2 className="text-lg font-semibold text-white">{title}</h2>
              </div>
              <p className="text-sm text-text-muted">{message}</p>
            </div>

            <div className="flex justify-end gap-3 p-4 border-t border-white/10 bg-white/[0.02]">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-text-muted hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onConfirm();
                  onClose();
                }}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  isDestructive 
                    ? 'bg-status-failed hover:bg-status-failed/90 text-white' 
                    : 'bg-accent hover:bg-accent-hover text-white'
                }`}
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
