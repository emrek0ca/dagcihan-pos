/** Konfigurasyona gore somut donanim adapterlerini uretir (fabrika). */
import type { DevicesConfig } from '../config/types.ts';
import type { PrinterPort, ScalePort, ScannerPort } from '../hardware/ports.ts';
import {
  FileTransport, NullTransport, SerialTransport, Tcp9100Transport, WindowsShareTransport,
} from '../hardware/printer/transports.ts';
import {
  HidWedgeScanner, SerialScanner, SimulatorScanner, TcpScanner,
} from '../hardware/scanner/adapters.ts';
import { CasTcpScale, CsvExportScale, SimulatorScale } from '../hardware/scale/adapters.ts';

export interface DeviceSet {
  readonly scanner: ScannerPort;
  readonly printer: PrinterPort;
  readonly scale: ScalePort;
  /** Uretimde olmamasi gereken adapterler (uyari icin) */
  readonly simulated: readonly string[];
}

export function createDevices(config: DevicesConfig): DeviceSet {
  const simulated: string[] = [];

  const framer = {
    terminators: config.scanner.terminatorChars,
    interCharTimeoutMs: config.scanner.interCharTimeoutMs,
  };

  let scanner: ScannerPort;
  switch (config.scanner.adapter) {
    case 'HID_WEDGE':
      scanner = new HidWedgeScanner(framer);
      break;
    case 'SERIAL':
      scanner = new SerialScanner({
        port: config.scanner.serial.port,
        baudRate: config.scanner.serial.baudRate,
        ...framer,
      });
      break;
    case 'TCP':
      scanner = new TcpScanner({
        host: config.scanner.tcp.host,
        port: config.scanner.tcp.port,
        ...framer,
      });
      break;
    case 'SIMULATOR':
      scanner = new SimulatorScanner();
      simulated.push('barkod okuyucu');
      break;
  }

  let printer: PrinterPort;
  switch (config.printer.adapter) {
    case 'TCP':
      printer = new Tcp9100Transport({
        host: config.printer.tcp.host,
        port: config.printer.tcp.port,
      });
      break;
    case 'WINDOWS_SHARE':
      printer = new WindowsShareTransport({ share: config.printer.share });
      break;
    case 'SERIAL':
      printer = new SerialTransport({
        port: config.printer.serial.port,
        baudRate: config.printer.serial.baudRate,
      });
      break;
    case 'FILE':
      printer = new FileTransport({ path: config.printer.file.path });
      simulated.push('fis yazicisi (dosya modu)');
      break;
    case 'NULL':
      printer = new NullTransport();
      simulated.push('fis yazicisi (bos)');
      break;
  }

  let scale: ScalePort;
  switch (config.scale.adapter) {
    case 'CSV_EXPORT':
      scale = new CsvExportScale({
        path: config.scale.export.path,
        departmentNo: config.scale.departmentNo,
      });
      break;
    case 'CAS_TCP':
      scale = new CasTcpScale({ host: config.scale.tcp.host, port: config.scale.tcp.port });
      break;
    case 'SIMULATOR':
      scale = new SimulatorScale();
      simulated.push('terazi');
      break;
  }

  return { scanner, printer, scale, simulated };
}
