import React, { useState } from 'react';
import { X, QrCode, Download, Copy, Check } from 'lucide-react';
import type { QrCodeData } from '../types';
import { api } from '../api';

interface QrCodeModalProps {
  isOpen: boolean;
  clientId: number | null;
  qrData: QrCodeData | null;
  onClose: () => void;
}

export const QrCodeModal: React.FC<QrCodeModalProps> = ({
  isOpen,
  clientId,
  qrData,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen || !qrData || !clientId) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(qrData.config);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadUrl = api.getClientConfigUrl(clientId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <QrCode className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-white">Конфигурация клиента</h2>
              <p className="text-xs text-zinc-400">{qrData.clientName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto flex flex-col items-center">
          {/* QR Code Container */}
          <div className="p-3 bg-white rounded-2xl shadow-xl">
            <img
              src={qrData.qrcode}
              alt="AmneziaWG QR Code"
              className="w-64 h-64 object-contain rounded-lg"
            />
          </div>
          <p className="text-xs text-zinc-400 text-center">
            Отсканируйте камерой смартфона в приложении <span className="text-emerald-400 font-medium">Amnezia VPN</span> или <span className="text-emerald-400 font-medium">AmneziaWG</span>
          </p>

          {/* Config Preview */}
          <div className="w-full">
            <div className="flex items-center justify-between mb-1.5 text-xs text-zinc-400">
              <span>Содержимое .conf</span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 transition"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Скопировано!' : 'Копировать'}</span>
              </button>
            </div>
            <pre className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono text-[11px] text-zinc-300 max-h-36 overflow-y-auto leading-relaxed whitespace-pre select-all">
              {qrData.config}
            </pre>
          </div>

          {/* Download Action */}
          <div className="w-full flex items-center gap-3 pt-2">
            <a
              href={downloadUrl}
              download={`${qrData.clientName}.conf`}
              className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm py-2.5 rounded-xl transition shadow-lg shadow-emerald-600/20"
            >
              <Download className="w-4 h-4" />
              <span>Скачать .conf файл</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
